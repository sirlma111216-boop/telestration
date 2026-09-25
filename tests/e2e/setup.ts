import type { RoomSnapshot } from '../../shared/types';
import { Client, classSocket, createClass, joinClass, roomSocket, teacherClassSocket, teacherLogin, type Student, type Teacher } from './harness.ts';

export interface RoomFixture {
  teacher: Teacher;
  classId: string;
  code: string;
  tc: Client<import('../../shared/types').ClassSnapshot>;
  hostStudent: Student;
  hostClass: Client<import('../../shared/types').ClassSnapshot>;
  host: Client<RoomSnapshot>;
  roomId: string;
  players: { student: Student; c: Client<RoomSnapshot>; cs: Client<import('../../shared/types').ClassSnapshot>; name: string }[];
}

/**
 * 교사 로그인 → 클래스 → 학생 방장 지정 → 방 생성 → n 명 입장·준비 까지.
 * hostMode 'observe' 면 방장은 플레이어가 아니고, 'play' 면 방장이 플레이어에 포함된다 (n 에 방장 포함).
 */
export async function setupRoom(n: number, hostMode: 'observe' | 'play' = 'observe', opts: { capacity?: number; ready?: boolean; className?: string; create?: Record<string, unknown> } = {}): Promise<RoomFixture> {
  const teacher = await teacherLogin();
  const cls = await createClass(teacher, opts.className ?? `클래스 ${n}명`);
  const tc = teacherClassSocket(teacher, cls.classId);
  await tc.opened;
  const hostStudent = await joinClass(cls.code, '방장');
  await tc.command({ type: 'class.grantHost', studentId: hostStudent.studentId, grant: true });
  const hostClass = classSocket(hostStudent);
  await hostClass.opened;
  await hostClass.waitFor((c) => !!c.snapshot?.me.hostGrant, 5000, 'host grant');
  const { roomId } = await hostClass.command<{ roomId: string }>({ type: 'room.create', title: `${n}인 방`, capacity: opts.capacity ?? 12, hostMode, settings: { drawSeconds: 60, guessSeconds: 30 }, ...opts.create });
  const host = roomSocket(hostStudent, roomId);
  await host.opened;
  const playerCount = hostMode === 'play' ? n - 1 : n;
  const players: RoomFixture['players'] = [];
  for (let i = 0; i < playerCount; i++) {
    const name = `학생${i + 1}`;
    const student = await joinClass(cls.code, name);
    const cs = classSocket(student);
    await cs.opened;
    await cs.command({ type: 'room.join', roomId });
    const c = roomSocket(student, roomId);
    await c.opened;
    players.push({ student, c, cs, name });
  }
  if (opts.ready !== false) {
    for (const p of players) await p.c.command({ type: 'room.ready', ready: true });
    if (hostMode === 'play') await host.command({ type: 'room.ready', ready: true });
    await host.waitFor((c) => !!c.snapshot && c.snapshot.members.filter((m) => m.isPlayer).every((m) => m.ready), 8000, 'all ready');
  }
  return { teacher, classId: cls.classId, code: cls.code, tc, hostStudent, hostClass, host, roomId, players };
}

export function allPlayers(f: RoomFixture): { c: Client<RoomSnapshot>; name: string }[] {
  const list = f.players.map((p) => ({ c: p.c, name: p.name }));
  if (f.host.snapshot?.me.isPlayer) list.unshift({ c: f.host, name: '방장' });
  return list;
}

export function teardown(f: RoomFixture): void {
  for (const p of f.players) {
    p.c.close();
    p.cs.close();
  }
  f.host.close();
  f.hostClass.close();
  f.tc.close();
}
