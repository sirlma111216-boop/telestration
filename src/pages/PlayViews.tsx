/** 플레이어 작업 화면: 제시어 선택 · 그리기 · 추측 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { LIMITS, type EntryPayload, type MyAssignment, type PromptSelectionView, type Stroke, type StrokeTool } from '@shared/types';
import type { ReconnectingSocket } from '../lib/socket';
import { useCountdown } from '../lib/clock';
import { clearLocalDraft, loadLocalDraft, saveLocalDraft } from '../lib/session';
import { DrawingCanvas, type DrawingCanvasHandle } from '../canvas/DrawingCanvas';
import { ConfirmModal, EntryCard, Notice, Pill, TimerBar, useAsyncAction } from '../components/ui';

// ---------- 제시어 선택 ----------

export function PromptSelectView({ ps, deadlineAt, sock }: { ps: PromptSelectionView; deadlineAt: number | null; sock: ReconnectingSocket }) {
  const left = useCountdown(deadlineAt);
  const { busy, run } = useAsyncAction();
  const [custom, setCustom] = useState('');
  const [composing, setComposing] = useState(false);
  const choose = (text: string) => run(() => sock.command({ type: 'prompt.choose', gameId: ps.gameId, stageId: ps.stageId, text }));

  if (ps.submitted) {
    return (
      <div className="flex flex-col gap-4">
        <TimerBar secondsLeft={left} total={LIMITS.promptSelectSeconds} />
        <div className="paper bg-mint-2 p-5 text-center">
          <div className="text-sm text-ink-2">내 제시어</div>
          <div className="mt-1 text-2xl font-extrabold">{ps.chosen}</div>
          <p className="mt-3 text-sm text-ink-2">다른 친구들이 고르는 동안 잠시 기다려요. 이 제시어는 기억해 두세요!</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <TimerBar secondsLeft={left} total={LIMITS.promptSelectSeconds} />
      <h2 className="text-lg font-extrabold">{ps.mode === 'choice' ? '제시어를 하나 고르세요' : '제시어를 직접 적어 주세요'}</h2>
      {ps.mode === 'choice' ? (
        <div className="grid gap-2">
          {ps.candidates.map((c) => (
            <button key={c} className="btn btn-violet justify-start text-left text-lg" disabled={busy} onClick={() => choose(c)}>
              {c}
            </button>
          ))}
        </div>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!composing && custom.trim()) choose(custom.trim());
          }}
        >
          <input
            className="input text-lg"
            value={custom}
            maxLength={LIMITS.promptMax}
            placeholder="예: 우산 쓴 강아지 (최대 40자)"
            onChange={(e) => setCustom(e.target.value.slice(0, LIMITS.promptMax))}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (composing || e.nativeEvent.isComposing)) e.preventDefault();
            }}
          />
          <button className="btn btn-primary" type="submit" disabled={busy || custom.trim().length === 0}>
            이 제시어로 정하기
          </button>
        </form>
      )}
      <p className="text-sm text-ink-2">시간이 지나면 후보 중 하나가 자동으로 정해져요.</p>
    </div>
  );
}

// ---------- 저장 상태 ----------

type SaveState = { local: boolean; server: 'idle' | 'pending' | 'saved' | 'failed'; savedAt: number | null };

function SaveIndicator({ s, connected }: { s: SaveState; connected: boolean }) {
  const text = s.server === 'saved' ? `서버 저장됨 ${s.savedAt ? new Date(s.savedAt).toLocaleTimeString('ko-KR', { hour12: false }) : ''}` : s.server === 'pending' ? '서버 저장 중…' : s.server === 'failed' ? '서버 저장 실패 (이 기기에는 저장됨)' : s.local ? '이 기기에 저장됨' : '';
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2" aria-live="polite">
      <span>{text}</span>
      {!connected && <Pill tone="coral">연결 끊김 — 아직 보내지 못한 초안이 있어요</Pill>}
    </div>
  );
}

// ---------- 그리기 ----------

export function DrawView({ a, deadlineAt, totalSeconds, sock, connected, sendLive }: { a: MyAssignment; deadlineAt: number | null; totalSeconds: number; sock: ReconnectingSocket; connected: boolean; sendLive: boolean }) {
  const left = useCountdown(deadlineAt);
  const canvasRef = useRef<DrawingCanvasHandle | null>(null);
  const [tool, setTool] = useState<StrokeTool>('pen');
  const [color, setColor] = useState<string>(LIMITS.colors[0]);
  const [widthIdx, setWidthIdx] = useState(1);
  const [confirmClear, setConfirmClear] = useState(false);
  const [save, setSave] = useState<SaveState>({ local: false, server: a.draft ? 'saved' : 'idle', savedAt: null });
  const [, bump] = useState(0);
  const { busy, run } = useAsyncAction();
  const key = `${a.gameId}:${a.stageId}`;

  const initial = useMemo<Stroke[]>(() => {
    const local = loadLocalDraft<{ strokes: Stroke[] }>(key);
    if (local?.strokes?.length) return local.strokes;
    return a.draft?.kind === 'drawing' ? a.draft.strokes : [];
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // 실시간 전송(150ms 묶음)과 서버 저장(2s) 주기를 분리
  const liveQueue = useRef<{ appended: Stroke[]; reset: boolean; full: Stroke[] | null }>({ appended: [], reset: false, full: null });
  const liveTimer = useRef<number | null>(null);
  const seq = useRef(0);
  const saveTimer = useRef<number | null>(null);
  const revision = useRef(a.draftRevision);
  const dirty = useRef(false);
  const sendLiveRef = useRef(sendLive);
  sendLiveRef.current = sendLive;

  const flushLive = () => {
    liveTimer.current = null;
    const q = liveQueue.current;
    if (!sendLiveRef.current) {
      liveQueue.current = { appended: [], reset: false, full: null };
      return;
    }
    if (q.reset) {
      seq.current += 1;
      sock.fire({ type: 'draft.live', gameId: a.gameId, stageId: a.stageId, seq: seq.current, reset: true, strokesAppend: q.full ?? [] });
    } else if (q.appended.length > 0) {
      seq.current += 1;
      sock.fire({ type: 'draft.live', gameId: a.gameId, stageId: a.stageId, seq: seq.current, strokesAppend: q.appended });
    }
    liveQueue.current = { appended: [], reset: false, full: null };
  };

  const flushSave = async () => {
    saveTimer.current = null;
    if (!dirty.current) return;
    const strokes = canvasRef.current?.getStrokes() ?? [];
    dirty.current = false;
    revision.current += 1;
    setSave((s) => ({ ...s, server: 'pending' }));
    try {
      await sock.command({ type: 'draft.save', gameId: a.gameId, stageId: a.stageId, revision: revision.current, payload: { kind: 'drawing', strokes } });
      setSave((s) => ({ ...s, server: 'saved', savedAt: Date.now() }));
    } catch {
      setSave((s) => ({ ...s, server: 'failed' }));
      dirty.current = true;
    }
  };

  const onChange = (strokes: Stroke[], appended: Stroke | null) => {
    saveLocalDraft(key, { strokes });
    setSave((s) => ({ ...s, local: true }));
    dirty.current = true;
    bump((n) => n + 1);
    if (appended && !liveQueue.current.reset) liveQueue.current.appended.push(appended);
    else {
      liveQueue.current.reset = true;
      liveQueue.current.full = strokes;
      liveQueue.current.appended = [];
    }
    if (liveTimer.current === null) liveTimer.current = window.setTimeout(flushLive, 150);
    if (saveTimer.current === null) saveTimer.current = window.setTimeout(() => void flushSave(), 2000);
  };

  // 초안이 있는 상태로 복원했으면 참관자에게 전체를 한 번 보낸다
  useEffect(() => {
    if (initial.length > 0 && sendLive) {
      liveQueue.current = { appended: [], reset: true, full: initial };
      if (liveTimer.current === null) liveTimer.current = window.setTimeout(flushLive, 150);
    }
    return () => {
      if (liveTimer.current) window.clearTimeout(liveTimer.current);
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = () =>
    run(async () => {
      const strokes = canvasRef.current?.getStrokes() ?? [];
      const payload: EntryPayload = { kind: 'drawing', strokes };
      await sock.command({ type: 'entry.submit', gameId: a.gameId, stageId: a.stageId, payload });
      clearLocalDraft(key);
    }, '제출했어요!');

  if (a.submitted) return <SubmittedView left={left} total={totalSeconds} kind="drawing" />;

  const widths = tool === 'pen' ? LIMITS.penWidths : LIMITS.eraserWidths;
  const strokeCount = canvasRef.current?.getStrokes().length ?? initial.length;

  return (
    <div className="flex flex-col gap-3 lg:grid lg:grid-cols-[1fr_15rem] lg:gap-5">
      <div className="flex flex-col gap-3">
        <TimerBar secondsLeft={left} total={totalSeconds} />
        <div className="paper bg-violet-2 p-3">
          <div className="text-xs font-bold text-ink-2">{a.bookOwnerName}의 그림책 · {a.stage}단계 · 이 내용을 그림으로 표현하세요</div>
          {a.previous ? (
            <div className="mt-1 text-xl font-extrabold break-keep">{a.previous.payload.kind === 'text' ? a.previous.payload.text || '(내용 없음)' : ''}</div>
          ) : (
            <div className="mt-1 font-bold">앞 사람의 내용이 없어요 (시간 초과·퇴장). 자유롭게 그려 보세요!</div>
          )}
          {a.previous && (a.previous.timedOut || a.previous.skipped) && <div className="mt-1 text-xs text-ink-2">앞 사람이 {a.previous.skipped ? '나가서' : '시간 초과로'} 내용을 못 남겼어요. 자유롭게 이어가요.</div>}
        </div>
        <DrawingCanvas ref={canvasRef} initialStrokes={initial} tool={tool} color={color} width={widths[widthIdx] ?? widths[1]} onChange={onChange} />
        <div className="flex items-center justify-between">
          <SaveIndicator s={save} connected={connected} />
          <span className="text-xs text-ink-2">획 {strokeCount}/{LIMITS.strokeMax}</span>
        </div>
        <p className="text-center text-xs text-ink-2">글자 대신 그림으로 표현해 주세요. 제출하면 고칠 수 없어요.</p>
      </div>

      <div className="sticky bottom-0 z-20 -mx-4 border-t-2 border-ink/10 bg-cream px-4 pb-[max(0.5rem,var(--safe-bottom))] pt-2 lg:static lg:m-0 lg:border-0 lg:bg-transparent lg:p-0">
        <div className="flex flex-col gap-2">
          <div className="flex gap-1.5" role="group" aria-label="도구">
            <button className={`btn btn-sm flex-1 ${tool === 'pen' ? 'btn-violet' : ''}`} aria-pressed={tool === 'pen'} onClick={() => setTool('pen')}>
              ✏️ 펜
            </button>
            <button className={`btn btn-sm flex-1 ${tool === 'eraser' ? 'btn-violet' : ''}`} aria-pressed={tool === 'eraser'} onClick={() => setTool('eraser')}>
              🧽 지우개
            </button>
          </div>
          <div className="flex gap-1.5" role="group" aria-label="굵기">
            {widths.map((w, i) => (
              <button key={w} className={`btn btn-sm flex-1 ${widthIdx === i ? 'btn-mint' : ''}`} aria-pressed={widthIdx === i} aria-label={`굵기 ${i + 1}`} onClick={() => setWidthIdx(i)}>
                <span className="inline-block rounded-full bg-ink" style={{ width: 6 + i * 6, height: 6 + i * 6 }} />
              </button>
            ))}
          </div>
          <div className="grid grid-cols-6 gap-1.5 lg:grid-cols-4" role="group" aria-label="색상">
            {LIMITS.colors.map((c) => (
              <button
                key={c}
                className={`h-11 w-full rounded-full border-2 ${color === c && tool === 'pen' ? 'border-ink ring-2 ring-violet ring-offset-2' : 'border-ink/30'}`}
                style={{ background: c }}
                aria-label={`색 ${c}`}
                aria-pressed={color === c}
                onClick={() => {
                  setColor(c);
                  setTool('pen');
                }}
              />
            ))}
          </div>
          <div className="flex gap-1.5">
            <button className="btn btn-sm flex-1" onClick={() => canvasRef.current?.undo()} disabled={!canvasRef.current?.canUndo()} aria-label="실행 취소">
              ↶ 취소
            </button>
            <button className="btn btn-sm flex-1" onClick={() => canvasRef.current?.redo()} disabled={!canvasRef.current?.canRedo()} aria-label="다시 실행">
              ↷ 복구
            </button>
            <button className="btn btn-sm flex-1" onClick={() => setConfirmClear(true)} disabled={!canvasRef.current?.canUndo()}>
              전체 지우기
            </button>
          </div>
          <button className="btn btn-primary text-lg" disabled={busy || left === 0} onClick={submit}>
            제출하기
          </button>
        </div>
      </div>
      {confirmClear && <ConfirmModal title="전체 지우기" message="그림을 모두 지울까요?" confirmLabel="지우기" danger onClose={() => setConfirmClear(false)} onConfirm={() => canvasRef.current?.clear()} />}
    </div>
  );
}

// ---------- 추측 ----------

export function GuessView({ a, deadlineAt, totalSeconds, sock, connected, sendLive }: { a: MyAssignment; deadlineAt: number | null; totalSeconds: number; sock: ReconnectingSocket; connected: boolean; sendLive: boolean }) {
  const left = useCountdown(deadlineAt);
  const key = `${a.gameId}:${a.stageId}`;
  const [text, setText] = useState<string>(() => loadLocalDraft<{ text: string }>(key)?.text ?? (a.draft?.kind === 'text' ? a.draft.text : ''));
  const [composing, setComposing] = useState(false);
  const [save, setSave] = useState<SaveState>({ local: false, server: a.draft ? 'saved' : 'idle', savedAt: null });
  const { busy, run } = useAsyncAction();
  const liveTimer = useRef<number | null>(null);
  const saveTimer = useRef<number | null>(null);
  const revision = useRef(a.draftRevision);
  const seq = useRef(0);
  const latest = useRef(text);
  latest.current = text;

  const onInput = (v: string) => {
    const next = v.slice(0, LIMITS.guessMax);
    setText(next);
    saveLocalDraft(key, { text: next });
    setSave((s) => ({ ...s, local: true }));
    if (sendLive && liveTimer.current === null) {
      liveTimer.current = window.setTimeout(() => {
        liveTimer.current = null;
        seq.current += 1;
        sock.fire({ type: 'draft.live', gameId: a.gameId, stageId: a.stageId, seq: seq.current, text: latest.current });
      }, 400);
    }
    if (saveTimer.current === null) {
      saveTimer.current = window.setTimeout(async () => {
        saveTimer.current = null;
        revision.current += 1;
        setSave((s) => ({ ...s, server: 'pending' }));
        try {
          await sock.command({ type: 'draft.save', gameId: a.gameId, stageId: a.stageId, revision: revision.current, payload: { kind: 'text', text: latest.current } });
          setSave((s) => ({ ...s, server: 'saved', savedAt: Date.now() }));
        } catch {
          setSave((s) => ({ ...s, server: 'failed' }));
        }
      }, 2000);
    }
  };
  useEffect(
    () => () => {
      if (liveTimer.current) window.clearTimeout(liveTimer.current);
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    },
    [],
  );

  const submit = () =>
    run(async () => {
      await sock.command({ type: 'entry.submit', gameId: a.gameId, stageId: a.stageId, payload: { kind: 'text', text: text.trim() } });
      clearLocalDraft(key);
    }, '제출했어요!');

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    // 한국어 IME 조합 중 Enter 는 제출하지 않는다
    if (composing || e.nativeEvent.isComposing) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    if (text.trim().length > 0) void submit();
  };

  if (a.submitted) return <SubmittedView left={left} total={totalSeconds} kind="guess" />;

  return (
    <div className="flex flex-col gap-3">
      <TimerBar secondsLeft={left} total={totalSeconds} />
      <div className="text-sm font-bold text-ink-2">
        {a.bookOwnerName}의 그림책 · {a.stage}단계 · 이 그림이 무엇인지 맞혀 보세요
      </div>
      {a.previous ? <EntryCard entry={a.previous} /> : <Notice>앞 사람의 그림이 없어요 (시간 초과·퇴장). 자유롭게 상상해서 적어 보세요!</Notice>}
      <label className="flex flex-col gap-1">
        <span className="font-bold">내 추측 (최대 80자) · 제출하면 고칠 수 없어요</span>
        <input
          className="input text-lg"
          value={text}
          onChange={(e) => onInput(e.target.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={(e) => {
            setComposing(false);
            onInput((e.target as HTMLInputElement).value);
          }}
          onKeyDown={onKeyDown}
          maxLength={LIMITS.guessMax}
          placeholder="예: 우산 쓴 강아지"
          autoComplete="off"
          enterKeyHint="done"
        />
      </label>
      <SaveIndicator s={save} connected={connected} />
      <button className="btn btn-primary text-lg" disabled={busy || text.trim().length === 0 || left === 0} onClick={submit}>
        제출하기
      </button>
    </div>
  );
}

function SubmittedView({ left, total, kind }: { left: number | null; total: number; kind: 'drawing' | 'guess' }) {
  return (
    <div className="flex flex-col gap-4">
      <TimerBar secondsLeft={left} total={total} />
      <div className="paper bg-mint-2 p-6 text-center">
        <div className="text-3xl">✅</div>
        <div className="mt-2 text-lg font-extrabold">{kind === 'drawing' ? '그림을 제출했어요' : '추측을 제출했어요'}</div>
        <p className="mt-1 text-sm text-ink-2">다른 친구들이 끝나거나 시간이 다 되면 다음 단계로 넘어가요.</p>
      </div>
    </div>
  );
}
