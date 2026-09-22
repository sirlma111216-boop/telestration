/** 학생 세션 (클래스별) 과 마지막 클래스 기억. 브라우저 저장소가 막혀 있어도 앱은 동작해야 한다. */

export interface StudentSession {
  classId: string;
  studentId: string;
  token: string;
  displayName: string;
  className: string;
}

const KEY = 'pr.student.sessions';
const LAST = 'pr.student.last';

function readAll(): Record<string, StudentSession> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, StudentSession>) : {};
  } catch {
    return {};
  }
}

export function getStudentSession(classId: string): StudentSession | null {
  return readAll()[classId] ?? null;
}

export function saveStudentSession(s: StudentSession): void {
  try {
    const all = readAll();
    all[s.classId] = s;
    localStorage.setItem(KEY, JSON.stringify(all));
    localStorage.setItem(LAST, s.classId);
  } catch {
    /* 저장 불가 환경 */
  }
}

export function clearStudentSession(classId: string): void {
  try {
    const all = readAll();
    delete all[classId];
    localStorage.setItem(KEY, JSON.stringify(all));
    if (localStorage.getItem(LAST) === classId) localStorage.removeItem(LAST);
  } catch {
    /* ignore */
  }
}

export function lastClassId(): string | null {
  try {
    return localStorage.getItem(LAST);
  } catch {
    return null;
  }
}

let actionCounter = 0;
export function newActionId(): string {
  actionCounter += 1;
  return `${Date.now().toString(36)}-${actionCounter}-${Math.random().toString(36).slice(2, 6)}`;
}

export function loadLocalDraft<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(`pr.draft.${key}`);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
export function saveLocalDraft(key: string, value: unknown): void {
  try {
    localStorage.setItem(`pr.draft.${key}`, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}
export function clearLocalDraft(key: string): void {
  try {
    localStorage.removeItem(`pr.draft.${key}`);
  } catch {
    /* ignore */
  }
}
