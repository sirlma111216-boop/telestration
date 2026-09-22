import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { Logo, Notice, Page, RETENTION_NOTICE, TopBar, useToast } from '../components/ui';

interface ClassRow {
  classId: string;
  name: string;
  code: string;
  createdAt: number;
}

export function TeacherDashboardPage({ teacher, onLogout }: { teacher: { teacherId: string; name: string }; onLogout: () => void }) {
  const toast = useToast();
  const [classes, setClasses] = useState<ClassRow[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    api<{ classes: ClassRow[] }>('/api/teacher/classes')
      .then((r) => setClasses(r.classes))
      .catch((e) => toast(e instanceof Error ? e.message : '불러오지 못했어요', 'error'));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    try {
      const r = await api<{ classId: string }>('/api/teacher/classes', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
      navigate(`/teacher/class/${r.classId}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : '만들지 못했어요', 'error');
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await api('/api/teacher/logout', { method: 'POST', body: '{}' }).catch(() => {});
    onLogout();
    navigate('/');
  };

  return (
    <Page>
      <TopBar
        title={teacher.name.endsWith('선생님') ? teacher.name : `${teacher.name} 선생님`}
        subtitle={<Logo small />}
        right={
          <button className="btn btn-ghost btn-sm" onClick={logout}>
            로그아웃
          </button>
        }
      />
      <form className="paper mb-5 flex flex-col gap-3 p-5" onSubmit={create}>
        <h2 className="font-extrabold">새 클래스 만들기</h2>
        <div className="flex gap-2">
          <input className="input" value={name} onChange={(e) => setName(e.target.value.slice(0, 30))} placeholder="예: 2학년 3반 미술" maxLength={30} />
          <button className="btn btn-primary shrink-0" type="submit" disabled={busy || !name.trim()}>
            만들기
          </button>
        </div>
      </form>
      <h2 className="mb-2 font-extrabold">내 클래스</h2>
      {classes === null ? (
        <p className="text-ink-2">불러오는 중…</p>
      ) : classes.length === 0 ? (
        <Notice>아직 클래스가 없어요. 위에서 첫 클래스를 만들어 보세요.</Notice>
      ) : (
        <ul className="flex flex-col gap-2">
          {classes.map((c) => (
            <li key={c.classId} className="paper flex items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <div className="truncate font-bold">{c.name}</div>
                <div className="text-sm text-ink-2">
                  코드 <span className="font-mono font-extrabold tracking-widest text-ink">{c.code}</span>
                </div>
              </div>
              <button className="btn btn-mint btn-sm" onClick={() => navigate(`/teacher/class/${c.classId}`)}>
                열기
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-6">
        <Notice>{RETENTION_NOTICE}</Notice>
      </div>
    </Page>
  );
}
