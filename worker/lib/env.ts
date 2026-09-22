import type { ClassObject } from '../do/ClassObject';
import type { DirectoryObject } from '../do/DirectoryObject';
import type { RoomObject } from '../do/RoomObject';

export interface Env {
  DIRECTORY: DurableObjectNamespace<DirectoryObject>;
  CLASSES: DurableObjectNamespace<ClassObject>;
  ROOMS: DurableObjectNamespace<RoomObject>;
  ASSETS: Fetcher;
  ENVIRONMENT: string;
  ALLOWED_ORIGINS?: string;
  /** JSON 배열: [{ id, username, name, passwordHash }] */
  TEACHER_ACCOUNTS?: string;
}

/** 워커가 신원을 확인한 뒤 Durable Object 로 넘기는 사용자 정보 */
export type Identity =
  | { kind: 'teacher'; teacherId: string; name: string }
  | { kind: 'student'; classId: string; studentId: string; nickname: string; displayName: string; hostGrant: boolean; currentRoomId: string | null };

export interface TeacherAccount {
  id: string;
  username: string;
  name: string;
  passwordHash: string;
}

export function parseTeacherAccounts(env: Env): TeacherAccount[] {
  if (!env.TEACHER_ACCOUNTS) return [];
  try {
    const parsed = JSON.parse(env.TEACHER_ACCOUNTS) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((a): a is TeacherAccount =>
        !!a && typeof a === 'object' && typeof (a as TeacherAccount).id === 'string' && typeof (a as TeacherAccount).username === 'string' && typeof (a as TeacherAccount).passwordHash === 'string',
      )
      .map((a) => ({ ...a, name: typeof a.name === 'string' && a.name ? a.name : a.username }));
  } catch {
    return [];
  }
}
