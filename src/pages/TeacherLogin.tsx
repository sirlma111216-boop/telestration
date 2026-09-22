import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { Logo, Notice, Page, useToast } from '../components/ui';

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
    <Page>
      <div className="flex flex-col items-center gap-2 py-6 text-center">
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
      <div className="mt-4 text-center">
        <button className="btn btn-ghost text-sm" onClick={() => navigate('/')}>
          학생 참여 화면으로
        </button>
      </div>
    </Page>
  );
}
