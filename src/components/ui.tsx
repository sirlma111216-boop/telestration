import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { EntryPayload, EntryView, MemberBadge } from '@shared/types';
import type { ConnectionState } from '../lib/socket';
import { StrokeViewer } from '../canvas/StrokeViewer';

// ---------- 토스트 ----------

interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'success';
}
const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, kind }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-3 z-50 flex flex-col items-center gap-2 px-4" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pop paper max-w-md px-4 py-2 text-sm font-bold ${t.kind === 'error' ? 'bg-coral-2 text-[#8a2a1f]' : t.kind === 'success' ? 'bg-mint-2' : 'bg-white'}`}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export function useToast() {
  return useContext(ToastCtx);
}

// ---------- 모달 ----------

export function Modal({ title, children, onClose, footer }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('button, input, [tabindex]')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-ink/40 p-3 sm:items-center" onClick={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className="paper pop w-full max-w-md bg-white p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-3 text-lg font-extrabold">{title}</h2>
        <div className="text-sm leading-relaxed">{children}</div>
        {footer && <div className="mt-4 flex flex-wrap justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmModal({ title, message, confirmLabel, danger, onConfirm, onClose }: { title: string; message: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => unknown; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {message}
    </Modal>
  );
}

// ---------- 배지 · 칩 ----------

export function BadgeMark({ badge, size = 22 }: { badge: MemberBadge; size?: number }) {
  const c = badge.color;
  const half = size / 2;
  let shape: ReactNode;
  switch (badge.shape) {
    case 'square':
      shape = <rect x={3} y={3} width={size - 6} height={size - 6} rx={3} fill={c} />;
      break;
    case 'triangle':
      shape = <polygon points={`${half},2 ${size - 2},${size - 2} 2,${size - 2}`} fill={c} />;
      break;
    case 'star':
      shape = <polygon points={starPoints(half, half, half - 1, half / 2.2)} fill={c} />;
      break;
    case 'heart':
      shape = <path d={`M${half} ${size - 3} C ${2} ${half} ${2} ${4} ${half / 1.6} ${4} C ${half} ${4} ${half} ${half / 1.5} ${half} ${half / 1.5} C ${half} ${half / 1.5} ${half} ${4} ${size - half / 1.6} ${4} C ${size - 2} ${4} ${size - 2} ${half} ${half} ${size - 3} Z`} fill={c} />;
      break;
    case 'diamond':
      shape = <polygon points={`${half},2 ${size - 2},${half} ${half},${size - 2} 2,${half}`} fill={c} />;
      break;
    default:
      shape = <circle cx={half} cy={half} r={half - 2} fill={c} />;
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="shrink-0">
      {shape}
      <text x={half} y={half + 4} textAnchor="middle" fontSize={size * 0.5} fontWeight={800} fill="#fff" stroke="#2b2f4a" strokeWidth={0.6}>
        {badge.number}
      </text>
    </svg>
  );
}

function starPoints(cx: number, cy: number, r: number, r2: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r2;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    pts.push(`${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`);
  }
  return pts.join(' ');
}

export function Pill({ children, tone = 'ink' }: { children: ReactNode; tone?: 'ink' | 'coral' | 'mint' | 'violet' | 'muted' }) {
  const cls =
    tone === 'coral' ? 'bg-coral-2 text-[#8a2a1f]' : tone === 'mint' ? 'bg-mint-2 text-[#1e5f50]' : tone === 'violet' ? 'bg-violet-2 text-[#4a3a8a]' : tone === 'muted' ? 'bg-cream-2 text-ink-2' : 'bg-white text-ink';
  return <span className={`chip ${cls}`}>{children}</span>;
}

// ---------- 연결 상태 ----------

export function ConnectionBanner({ state, detail }: { state: ConnectionState; detail?: string }) {
  if (state === 'open') return null;
  const text = state === 'connecting' ? '연결하는 중이에요…' : state === 'reconnecting' ? '연결이 끊겨 다시 연결하는 중이에요. 화면이 최신이 아닐 수 있어요.' : detail || '연결이 종료되었어요.';
  return (
    <div className={`sticky top-0 z-30 px-4 py-2 text-center text-sm font-bold ${state === 'closed' ? 'bg-coral text-white' : 'bg-sun text-ink'}`} role="status">
      {text}
    </div>
  );
}

// ---------- 타이머 ----------

export function TimerBar({ secondsLeft, total }: { secondsLeft: number | null; total: number }) {
  if (secondsLeft === null) return null;
  const pct = Math.max(0, Math.min(100, (secondsLeft / total) * 100));
  const urgent = secondsLeft <= 10;
  return (
    <div className="flex items-center gap-3" aria-live="polite" aria-atomic="true">
      <div className="h-3 flex-1 overflow-hidden rounded-full border-2 border-ink bg-white">
        <div className={`h-full transition-[width] duration-300 ${urgent ? 'bg-coral' : 'bg-mint'}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`min-w-[3.5rem] text-right text-lg font-extrabold tabular-nums ${urgent ? 'text-coral' : ''}`}>{secondsLeft}초</span>
    </div>
  );
}

// ---------- 항목 표시 ----------

export function PayloadView({ payload, timedOut, skipped, kind, big }: { payload: EntryPayload | null; timedOut?: boolean; skipped?: boolean; kind: 'prompt' | 'drawing' | 'guess'; big?: boolean }) {
  const empty = !payload || (payload.kind === 'drawing' ? payload.strokes.length === 0 : payload.text.length === 0);
  if (empty) {
    return (
      <div className={`paper flex items-center justify-center bg-cream-2 text-center text-ink-2 ${kind === 'drawing' ? 'aspect-[4/3]' : 'min-h-24'} p-4`}>
        <p className="font-bold">{skipped ? '이 사람은 방을 나가서 내용이 없어요' : timedOut ? '시간 초과로 내용이 없어요' : '내용이 없어요'}</p>
      </div>
    );
  }
  if (payload.kind === 'drawing') return <StrokeViewer strokes={payload.strokes} label="그림" />;
  return (
    <div className={`paper flex min-h-24 items-center justify-center bg-white p-4 text-center ${big ? 'text-2xl sm:text-3xl' : 'text-lg'} font-extrabold break-keep`}>
      {payload.text}
    </div>
  );
}

export function EntryCard({ entry, caption }: { entry: EntryView; caption?: string }) {
  const label = entry.kind === 'prompt' ? '제시어' : entry.kind === 'drawing' ? '그림' : '추측';
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm text-ink-2">
        <span className="font-bold">
          {label} · {entry.authorName}
        </span>
        {caption && <span>{caption}</span>}
      </div>
      <PayloadView payload={entry.payload} timedOut={entry.timedOut} skipped={entry.skipped} kind={entry.kind} big={entry.kind !== 'drawing'} />
    </div>
  );
}

// ---------- 레이아웃 ----------

export function Page({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <main className={`mx-auto w-full ${wide ? 'max-w-6xl' : 'max-w-xl'} px-4 pb-8 pt-4 sm:px-6`}>{children}</main>;
}

export function TopBar({ title, subtitle, right }: { title: string; subtitle?: ReactNode; right?: ReactNode }) {
  return (
    <header className="mb-4 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="truncate text-xl font-extrabold sm:text-2xl">{title}</h1>
        {subtitle && <div className="mt-0.5 text-sm text-ink-2">{subtitle}</div>}
      </div>
      {right && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{right}</div>}
    </header>
  );
}

export function Logo({ small }: { small?: boolean }) {
  return (
    <div className={`flex items-center gap-2 ${small ? 'text-lg' : 'text-3xl'} font-extrabold`}>
      <svg width={small ? 26 : 40} height={small ? 26 : 40} viewBox="0 0 64 64" aria-hidden="true">
        <rect width="64" height="64" rx="14" fill="#fff" stroke="#2b2f4a" strokeWidth="3" />
        <path d="M14 46 L40 20 l6 6 L20 52 l-8 2z" fill="#f4735f" stroke="#2b2f4a" strokeWidth="3" strokeLinejoin="round" />
        <path d="M40 20 l4-4 6 6-4 4z" fill="#b7a4f2" stroke="#2b2f4a" strokeWidth="3" strokeLinejoin="round" />
        <circle cx="22" cy="18" r="3" fill="#6fcdb7" />
      </svg>
      <span>그림 이어말하기</span>
    </div>
  );
}

export function Notice({ tone = 'muted', children }: { tone?: 'muted' | 'coral' | 'mint' | 'violet'; children: ReactNode }) {
  const cls = tone === 'coral' ? 'bg-coral-2' : tone === 'mint' ? 'bg-mint-2' : tone === 'violet' ? 'bg-violet-2' : 'bg-cream-2';
  return <div className={`rounded-xl border-2 border-ink/20 px-4 py-3 text-sm leading-relaxed ${cls}`}>{children}</div>;
}

export function useAsyncAction() {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const run = useCallback(
    async (fn: () => Promise<unknown>, successText?: string) => {
      if (busy) return false;
      setBusy(true);
      try {
        await fn();
        if (successText) toast(successText, 'success');
        return true;
      } catch (e) {
        toast(e instanceof Error ? e.message : '실패했어요', 'error');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, toast],
  );
  return useMemo(() => ({ busy, run }), [busy, run]);
}

export const RETENTION_NOTICE = '클래스와 게임 데이터는 마지막 활동 후 24시간이 지나면 자동으로 지워져요. 그림·추측·명단은 저장하지 않아요.';
