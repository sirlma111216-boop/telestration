import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { Illustration, Logo, Notice, Page, useToast } from '../components/ui';

export function TeacherLoginPage({ onLogin }: { onLogin: (t: { teacherId: string; name: string }) => void }) {
  const toast = useToast();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const res = await api<{ teacher: { teacherId: string; name: string } }>('/api/teacher/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      onLogin(res.teacher);
      navigate('/teacher', true);
    } catch (err) {
      toast(err instanceof Error ? err.message : '로그인하지 못했어요', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page wide>
      {/* 학생 참여 화면과 같은 배치: 컴퓨터·태블릿은 왼쪽 입력창 + 오른쪽 그림, 휴대폰은 입력창만 */}
      <div className="mx-auto grid max-w-5xl items-center gap-8 py-4 md:grid-cols-[minmax(0,24rem)_1fr]">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col items-center gap-2 text-center md:items-start md:text-left">
            <Logo />
            <p className="text-ink-2">교사 로그인</p>
          </div>
          <form className="paper flex flex-col gap-4 p-5" onSubmit={submit}>
            <label className="flex flex-col gap-1">
              <span className="text-sm font-bold">아이디</span>
              <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm font-bold">비밀번호</span>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            </label>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? '확인하는 중…' : '로그인'}
            </button>
            <Notice>교사 계정은 운영자가 서버 설정으로 준비해요. 계정이 없다면 관리자에게 문의하세요.</Notice>
          </form>
          <div className="text-center md:text-left">
            <button className="btn btn-ghost text-sm" onClick={() => navigate('/')}>
              학생 참여 화면으로
            </button>
          </div>
        </div>

        <Illustration src="/images/friends.webp" alt="친구들이 태블릿과 휴대폰으로 그림을 그리며 웃고 있는 그림" className="hidden w-full rounded-2xl md:block" />
      </div>
    </Page>
  );
}
