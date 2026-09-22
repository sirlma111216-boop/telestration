import { useEffect, useState, type FormEvent } from 'react';
import { canonicalCode } from '@shared/ids';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { getStudentSession, lastClassId, saveStudentSession } from '../lib/session';
import { Illustration, Logo, Notice, Page, RETENTION_NOTICE, useToast } from '../components/ui';

export function HomePage({ presetCode }: { presetCode?: string }) {
  const toast = useToast();
  const [code, setCode] = useState(presetCode ?? '');
  const [nickname, setNickname] = useState('');
  const [className, setClassName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const last = lastClassId();
  const lastSession = last ? getStudentSession(last) : null;

  useEffect(() => {
    const c = canonicalCode(code);
    if (c.length !== 6) {
      setClassName(null);
      return;
    }
    let cancelled = false;
    api<{ name: string; locked: boolean }>(`/api/class/lookup?code=${encodeURIComponent(c)}`)
      .then((r) => {
        if (!cancelled) setClassName(r.locked ? `${r.name} (입장 잠김)` : r.name);
      })
      .catch(() => {
        if (!cancelled) setClassName(null);
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const res = await api<{ classId: string; studentId: string; token: string; displayName: string }>('/api/class/join', {
        method: 'POST',
        body: JSON.stringify({ code: canonicalCode(code), nickname: nickname.trim() }),
      });
      saveStudentSession({ ...res, className: className ?? '' });
      navigate(`/class/${res.classId}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : '참여하지 못했어요', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page>
      {/* 가운데가 빈 테두리 낙서. object-cover 로 채우면 양옆 낙서가 잘려 나가므로 contain 으로 전체를 보여 준다.
          남는 위아래 여백은 페이지 배경색과 같아 티가 나지 않는다. 좁은 화면에서는 숨긴다. */}
      <Illustration src="/images/hero-bg.webp" className="pointer-events-none fixed inset-0 -z-10 hidden h-full w-full object-contain md:block" />
      <div className="flex flex-col items-center gap-2 py-6 text-center">
        <Logo />
        <p className="max-w-sm text-ink-2">제시어를 그림으로, 그림을 말로. 친구들에게 전달하다 보면 이야기가 어디로 갈까요?</p>
      </div>
      {lastSession && (
        <div className="paper mb-4 flex items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <div className="text-xs text-ink-2">최근 참여한 클래스</div>
            <div className="truncate font-bold">
              {lastSession.className || '클래스'} · {lastSession.displayName}
            </div>
          </div>
          <button className="btn btn-mint btn-sm" onClick={() => navigate(`/class/${lastSession.classId}`)}>
            이어서 참여
          </button>
        </div>
      )}
      <form className="paper flex flex-col gap-4 p-5" onSubmit={onSubmit}>
        <h2 className="text-lg font-extrabold">클래스 참여하기</h2>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-bold">입장 코드</span>
          <input
            className="input text-center text-2xl font-extrabold uppercase tracking-[0.3em]"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 6))}
            placeholder="ABC123"
            autoComplete="off"
            inputMode="text"
            maxLength={6}
            aria-describedby="code-help"
          />
          <span id="code-help" className="min-h-5 text-sm text-ink-2">
            {className ? `클래스: ${className}` : '선생님이 알려 준 6자리 코드를 입력하세요'}
          </span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-bold">닉네임 (2~12자)</span>
          <input className="input" value={nickname} onChange={(e) => setNickname(e.target.value.slice(0, 12))} placeholder="예: 바나나" maxLength={12} autoComplete="off" />
        </label>
        <button className="btn btn-primary text-lg" type="submit" disabled={busy || canonicalCode(code).length !== 6 || nickname.trim().length < 2}>
          {busy ? '참여하는 중…' : '참여하기'}
        </button>
        <Notice>{RETENTION_NOTICE} 이메일이나 개인정보는 받지 않아요.</Notice>
      </form>
      <Illustration src="/images/friends.webp" alt="친구들이 태블릿과 휴대폰으로 그림을 그리며 웃고 있는 그림" className="mx-auto mt-6 w-full max-w-md rounded-2xl" />
      <div className="mt-6 text-center">
        <button className="btn btn-ghost text-sm" onClick={() => navigate('/teacher')}>
          선생님이신가요? 교사 로그인
        </button>
      </div>
    </Page>
  );
}
