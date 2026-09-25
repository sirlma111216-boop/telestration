/**
 * 차례를 기다리는 동안의 가벼운 배경 음악 — Web Audio API 로 직접 만든 짧은 루프 (외부 음원 없음).
 *
 *  - 사용자가 '소리 켜기' 를 누른 뒤에만 재생한다 (브라우저 자동 재생 제한을 지킨다).
 *  - 앱 전체에서 **하나만** 존재한다 (모듈 단일 인스턴스). 화면을 옮기거나 재접속해도 두 번 겹쳐 울리지 않는다.
 *  - 탭이 보이지 않으면 멈추고, 다시 보이면 이어서 튼다.
 *  - 내 차례가 되면 음악을 멈추고 짧은 알림음을 낸다.
 *  - 재생이 막혀도(오디오 미지원·거부) 게임은 그대로 진행된다. 상태만 'blocked' 로 둔다.
 *
 * 음악: 도-레-미-솔-라 5음 음계의 느린 아르페지오와 낮은 음. 이 파일의 코드가 곧 악보다 (저작권 문제 없음).
 */

export type MusicState = 'off' | 'on' | 'blocked';

interface Prefs {
  /** 한 번이라도 소리를 켰는지 — 다음 방문 때 첫 터치에서 자동으로 다시 켠다 */
  wanted: boolean;
  muted: boolean;
  volume: number; // 0..1
}

const PREFS_KEY = 'pr.music';
const STEP_SECONDS = 0.34;
const LOOKAHEAD = 0.4;
// 5음 음계 (C5 D5 E5 G5 A5) 와 낮은 음 (C3 G2 A2 F2)
const MELODY = [523.25, 659.25, 783.99, 880.0, 783.99, 659.25, 587.33, 659.25];
const BASS = [130.81, 98.0, 110.0, 87.31];

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Prefs>;
      return { wanted: !!p.wanted, muted: !!p.muted, volume: typeof p.volume === 'number' ? Math.min(1, Math.max(0, p.volume)) : 0.5 };
    }
  } catch {
    /* 저장소를 못 쓰는 환경 */
  }
  return { wanted: false, muted: false, volume: 0.5 };
}

type Listener = () => void;

class WaitingMusic {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private timer: number | null = null;
  private nextTime = 0;
  private step = 0;
  private waiting = false;
  private listeners = new Set<Listener>();
  private gestureArmed = false;
  state: MusicState = 'off';
  prefs: Prefs = typeof window === 'undefined' ? { wanted: false, muted: false, volume: 0.5 } : loadPrefs();

  constructor() {
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', () => this.sync());
    // 전에 소리를 켰던 사람은 다음 첫 터치·키 입력 때 다시 켠다 (사용자 동작이 있어야 소리를 낼 수 있다)
    if (this.prefs.wanted) this.armGesture();
  }

  /** 테스트·진단용: 지금 돌고 있는 루프 수 (0 또는 1) */
  get activeLoops(): number {
    return this.timer === null ? 0 : 1;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private savePrefs(): void {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs));
    } catch {
      /* ignore */
    }
  }

  private armGesture(): void {
    if (this.gestureArmed || typeof document === 'undefined') return;
    this.gestureArmed = true;
    const once = () => {
      document.removeEventListener('pointerdown', once, true);
      document.removeEventListener('keydown', once, true);
      this.gestureArmed = false;
      if (this.prefs.wanted && this.state !== 'on') void this.enable();
    };
    document.addEventListener('pointerdown', once, true);
    document.addEventListener('keydown', once, true);
  }

  /** '소리 켜기' — 반드시 사용자 동작(클릭) 안에서 부른다 */
  async enable(): Promise<boolean> {
    try {
      if (!this.ctx) {
        const Ctor: typeof AudioContext | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) throw new Error('no audio');
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      if (this.ctx.state !== 'running') throw new Error('blocked');
      this.state = 'on';
      this.prefs.wanted = true;
      this.savePrefs();
    } catch {
      // 재생이 막혀도 게임은 그대로. 다음 사용자 동작 때 다시 시도한다.
      this.state = 'blocked';
      this.armGesture();
    }
    this.sync();
    this.emit();
    return this.state === 'on';
  }

  /** '소리 끄기' — 다음 방문에도 자동으로 켜지 않는다 */
  disable(): void {
    this.prefs.wanted = false;
    this.savePrefs();
    this.state = 'off';
    this.stopLoop();
    this.emit();
  }

  setMuted(muted: boolean): void {
    this.prefs.muted = muted;
    this.savePrefs();
    this.sync();
    this.emit();
  }

  setVolume(volume: number): void {
    this.prefs.volume = Math.min(1, Math.max(0, volume));
    this.savePrefs();
    if (this.master && this.ctx && this.timer !== null) this.master.gain.setTargetAtTime(this.prefs.volume * 0.25, this.ctx.currentTime, 0.1);
    this.emit();
  }

  /** 차례를 기다리는 중인지. 화면이 바뀔 때마다 불러도 루프는 하나만 돈다. */
  setWaiting(waiting: boolean): void {
    if (this.waiting === waiting) return;
    this.waiting = waiting;
    this.sync();
  }

  /** 내 차례 알림: 음악을 멈추고 짧게 두 번 울린다 */
  chime(): void {
    this.setWaiting(false);
    if (this.state !== 'on' || this.prefs.muted || !this.ctx) return;
    const t = this.ctx.currentTime + 0.02;
    this.tone(880, t, 0.18, 0.35 * this.prefs.volume + 0.1, 'triangle', this.ctx.destination);
    this.tone(1318.5, t + 0.16, 0.26, 0.35 * this.prefs.volume + 0.1, 'triangle', this.ctx.destination);
  }

  private sync(): void {
    const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
    const shouldPlay = this.state === 'on' && !this.prefs.muted && this.waiting && visible;
    if (shouldPlay) this.startLoop();
    else this.stopLoop();
  }

  private startLoop(): void {
    if (this.timer !== null || !this.ctx || !this.master) return; // 이미 돌고 있으면 새로 만들지 않는다
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setTargetAtTime(this.prefs.volume * 0.25, this.ctx.currentTime, 0.3);
    this.nextTime = this.ctx.currentTime + 0.05;
    this.timer = window.setInterval(() => this.schedule(), 100);
    this.schedule();
  }

  private stopLoop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15);
  }

  private schedule(): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    while (this.nextTime < ctx.currentTime + LOOKAHEAD) {
      const i = this.step % MELODY.length;
      this.tone(MELODY[i]!, this.nextTime, STEP_SECONDS * 0.9, 0.5, 'sine', master);
      if (i % 2 === 0) this.tone(BASS[(this.step / 2) % BASS.length | 0]!, this.nextTime, STEP_SECONDS * 1.8, 0.35, 'triangle', master);
      this.nextTime += STEP_SECONDS;
      this.step += 1;
    }
  }

  private tone(freq: number, at: number, dur: number, gain: number, type: OscillatorType, dest: AudioNode): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(g).connect(dest);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }
}

export const waitingMusic = new WaitingMusic();

declare global {
  interface Window {
    __waitingMusic?: WaitingMusic;
  }
}
if (typeof window !== 'undefined' && import.meta.env.DEV) window.__waitingMusic = waitingMusic;
