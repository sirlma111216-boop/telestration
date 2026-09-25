import { useEffect, useState } from 'react';
import { api } from './lib/api';
import { matchPath, navigate, usePath } from './lib/router';
import { ToastProvider } from './components/ui';
import { HomePage } from './pages/Home';
import { TeacherLoginPage } from './pages/TeacherLogin';
import { TeacherDashboardPage } from './pages/TeacherDashboard';
import { TeacherClassPage } from './pages/TeacherClass';
import { StudentLobbyPage } from './pages/StudentLobby';
import { RoomPage } from './pages/RoomPage';
import { getStudentSession, lastClassId } from './lib/session';
import { CanvasPlayground } from './pages/CanvasPlayground';
import { FaPlayground } from './pages/FaPlayground';

type Teacher = { teacherId: string; name: string };

export default function App() {
  const path = usePath();
  const [teacher, setTeacher] = useState<Teacher | null | undefined>(undefined);

  useEffect(() => {
    if (!path.startsWith('/teacher')) return;
    if (teacher !== undefined) return;
    api<{ teacher: Teacher }>('/api/teacher/me')
      .then((r) => setTeacher(r.teacher))
      .catch(() => setTeacher(null));
  }, [path, teacher]);

  let page: React.ReactNode;
  let params: Record<string, string> | null;

  if (path === '/' || path === '') page = <HomePage />;
  else if (import.meta.env.DEV && path === '/dev/canvas') page = <CanvasPlayground />;
  else if (import.meta.env.DEV && path === '/dev/fa') page = <FaPlayground />;
  else if ((params = matchPath('/join/:code', path))) page = <HomePage presetCode={params.code!} />;
  else if (path.startsWith('/teacher')) {
    if (teacher === undefined) page = <p className="py-10 text-center text-ink-2">확인하는 중…</p>;
    else if (!teacher) page = <TeacherLoginPage onLogin={setTeacher} />;
    else if ((params = matchPath('/teacher/class/:classId', path))) page = <TeacherClassPage key={params.classId} classId={params.classId!} />;
    else if ((params = matchPath('/teacher/room/:roomId', path))) {
      const classId = new URLSearchParams(window.location.search).get('class');
      page = <RoomPage key={params.roomId} roomId={params.roomId!} mode="teacher" classId={classId} />;
    } else page = <TeacherDashboardPage teacher={teacher} onLogout={() => setTeacher(null)} />;
  } else if ((params = matchPath('/class/:classId', path))) page = <StudentLobbyPage key={params.classId} classId={params.classId!} />;
  else if ((params = matchPath('/room/:roomId', path))) {
    // 학생의 방 페이지: 어느 클래스 세션을 쓸지 마지막 클래스에서 찾는다
    const classId = lastClassId();
    const session = classId ? getStudentSession(classId) : null;
    page = <RoomPage key={params.roomId} roomId={params.roomId!} mode="student" classId={session ? classId : null} />;
  } else {
    page = (
      <div className="py-10 text-center">
        <p className="mb-4 font-bold">페이지를 찾을 수 없어요.</p>
        <button className="btn" onClick={() => navigate('/')}>
          처음으로
        </button>
      </div>
    );
  }

  return <ToastProvider>{page}</ToastProvider>;
}
