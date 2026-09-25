# API · WebSocket 메시지 명세

타입 정의의 원본은 [`shared/protocol.ts`](../shared/protocol.ts) 와 [`shared/types.ts`](../shared/types.ts) 다. 이 문서는 요약이다.

## HTTP API

상태 변경(POST) 요청과 WebSocket 업그레이드는 `Origin` 헤더가 자기 자신 또는 `ALLOWED_ORIGINS` 와 일치해야 한다 (CSRF 방어).

| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| POST | `/api/teacher/login` | – | `{username, password}` → 교사 세션 쿠키 `pr_teacher` (HttpOnly, SameSite=Lax, https 면 Secure). IP·아이디 기준 10분 8회 실패 제한 |
| POST | `/api/teacher/logout` | 쿠키 | 세션 삭제 |
| GET | `/api/teacher/me` | 쿠키 | 교사 정보 |
| GET | `/api/teacher/classes` | 쿠키 | 내 클래스 목록 |
| POST | `/api/teacher/classes` | 쿠키 | `{name}` → `{classId, code, name}` |
| GET | `/api/teacher/classes/:classId` | 쿠키 (소유자) | 클래스 스냅샷 |
| GET | `/api/class/lookup?code=` | – | `{classId, name, locked}` (IP 분당 30회) |
| POST | `/api/class/join` | – | `{code, nickname}` → `{classId, studentId, token, displayName}` (IP 분당 20회) |
| GET | `/api/student/me` | `Authorization: Bearer <token>` | 학생 세션 확인 |

학생 토큰 형식: `<classId>.<secret>`. 서버는 secret 의 SHA-256 만 저장한다.

## WebSocket

- 클래스: `GET /ws/class/:classId?token=<학생토큰>` 또는 `?as=teacher` (쿠키)
- 게임방: `GET /ws/room/:roomId?token=<학생토큰>` 또는 `?as=teacher`

연결 직후 서버가 스냅샷(`class.snapshot` / `room.snapshot`)을 보낸다. 클라이언트 명령은 `clientActionId` 를 포함하고 서버는 항상 `ack` 로 응답한다.

```json
{ "type": "ack", "clientActionId": "…", "ok": true, "result": … }
{ "type": "ack", "clientActionId": "…", "ok": false, "error": "invalid", "message": "…" }
```

### 클래스 채널

| 방향 | type | 누가 | 내용 |
|---|---|---|---|
| C→S | `class.ping` | 모두 | 서버 시각 |
| C→S | `class.lock` | 교사 | `{locked}` |
| C→S | `class.end` | 교사 | `{confirm: true}` 모든 방 종료 · 세션 해제 · 데이터 삭제 예약 |
| C→S | `class.grantHost` | 교사 | `{studentId, grant}` |
| C→S | `class.kick` | 교사 | `{studentId}` |
| C→S | `room.create` | 교사 · 방장 자격 학생 | `{title, capacity, hostMode, hostStudentId?, settings?}` → `{roomId}` |
| C→S | `room.assignHost` | 교사 | `{roomId, studentId}` (그 방 참가자 + 자격 보유자만) |
| C→S | `room.takeOver` | 교사 | `{roomId}` |
| C→S | `room.forceClose` | 교사 | `{roomId, confirm: true}` |
| C→S | `room.join` | 학생 | `{roomId}` 입장 예약 → RoomObject 입장 → 확정 |
| C→S | `room.leave` | 학생 | `{roomId}` |
| S→C | `class.snapshot` | – | `ClassSnapshot` (교사에겐 명단 포함, 학생에겐 방 목록·본인 정보) |
| S→C | `class.ended` / `class.kicked` | – | 이후 소켓 종료(4000/4003) |

### 게임방 채널

| 방향 | type | 누가 | 내용 |
|---|---|---|---|
| C→S | `room.ping` / `room.resync` | 모두 | 스냅샷 재요청 |
| C→S | `room.ready` | 플레이어 | `{ready}` (대기실) |
| C→S | `room.leave` | 학생 | 대기실이면 제거, 진행 중이면 남은 작업 건너뜀 |
| C→S | `room.updateSettings` | 방장 | `{expectedVersion, title?, capacity?, hostMode?, promptMode?, drawSeconds?, guessSeconds?}` (대기실) |
| C→S | `room.kick` | 방장 | `{userId}` (대기실) |
| C→S | `game.start` | 방장 | `{expectedVersion}` — 4~12명 · 전원 접속·준비 |
| C→S | `prompt.choose` | 플레이어 | `{gameId, stageId, text}` |
| C→S | `draft.live` | 플레이어 | `{gameId, stageId, seq, strokesAppend?, reset?, text?}` ack 없음 · 참관자에게만 전달 · 영구 저장 안 함 |
| C→S | `draft.save` | 플레이어 | `{gameId, stageId, revision, payload}` 영구 저장 (≤2초 주기) |
| C→S | `entry.submit` | 플레이어 | `{gameId, stageId, payload}` 저장 후 ack · 멱등 |
| C→S | `monitor.subscribe` | 교사 · 참관 방장 | `{subscribe}` 권한 없으면 `monitor.denied` |
| C→S | `reveal.start` | 방장 | `{gameId, expectedVersion}` REVEAL_READY → REVEALING |
| C→S | `reveal.selectBook` | 방장 | `{gameId, bookId, expectedRevision}` |
| C→S | `reveal.step` | 방장 | `{gameId, direction: 1|-1, expectedRevision}` |
| C→S | `reveal.reaction` | 모두 | `{gameId, reaction}` 1.5초 1회 |
| C→S | `room.restart` | 방장 | `{expectedVersion}` FINISHED 에서만 |
| C→S | `room.close` | 방장 | `{confirm: true}` LOBBY·FINISHED 에서만 |
| C→S | `room.forceClose` | 교사 | `{confirm: true}` |
| C→S | `room.updateSettings` (가짜 예술가) | 방장 | `{expectedVersion, gameMode?, faCategoryId?, faTurnSeconds?, faDiscussionSeconds?}` 모드를 바꾸면 준비·펜 색 초기화 |
| C→S | `fa.color` | 플레이어 | `{colorIndex}` 대기실 · 먼저 고른 사람이 가짐 |
| C→S | `fa.roleAck` | 플레이어 | `{gameId, phaseId}` |
| C→S | `fa.draft` | 현재 차례 | `{gameId, turnId, revision, stroke}` ack 없음 · 검증 후 모두에게 전달 · 1.5초 묶음 저장(마지막 것은 반드시) |
| C→S | `fa.redo` | 현재 차례 | `{gameId, turnId, revision}` revision 을 올려야 함 · 낮은 revision 의 늦은 초안·확정은 무시·거부 |
| C→S | `fa.commit` | 현재 차례 | `{gameId, turnId, revision, stroke}` 경로 하나 · 저장 후 ack · 멱등 |
| C→S | `fa.vote` | 플레이어 | `{gameId, phaseId, targetId}` 자기 자신 금지 · 변경 금지 |
| C→S | `fa.guess` | 가짜 예술가 | `{gameId, phaseId, text}` ≤40자 · 다른 사람에게 알리지 않음 |
| C→S | `fa.reveal.start` / `fa.reveal.next` | 방장 | `{gameId}` / `{gameId, expectedStep}` 한 단계씩 앞으로만 |
| C→S | `fa.highlight` | 방장 | `{gameId, playerId|null, expectedRevision}` FINISHED 에서만 |
| S→C | `fa.draft` | 모두 (그리는 사람 제외) | `{gameId, turnId, playerId, revision, stroke|null}` |
| S→C | `room.snapshot` | – | `RoomSnapshot` — 권한별로 다르게 구성 (아래) |
| S→C | `monitor.snapshot` / `monitor.update` | 구독한 참관자 | 플레이어별 초안 |
| S→C | `reveal.reaction` | 모두 | `{reaction, from}` |
| S→C | `room.closed` / `room.kicked` | – | 이후 소켓 종료(4000/4002) |

### 스냅샷의 권한별 차이

| 필드 | 플레이어 | 참관 방장 / 교사 | 진행권 보유자 |
|---|---|---|---|
| `assignment` (내 작업·직전 항목·내 초안) | ✅ | – | 플레이어일 때만 |
| `promptSelection` | ✅ | – | 플레이어일 때만 |
| `reveal` (현재 공개 항목 하나) | ✅ | ✅ | ✅ |
| `revealBooks` (책별 공개 진행 상황) | ❌ (`null`) | ❌ | ✅ |
| `monitor.*` | ❌ | 구독 시 ✅ | 참관일 때만 |

학생 스냅샷에는 다른 사람의 초안, 미공개 항목, 전체 그림책 목록이 절대 포함되지 않는다.

가짜 예술가 찾기의 `snap.fa` 는 `buildFaView()` 가 보는 사람마다 새로 만든다.

| 필드 | 예술가 | 가짜 예술가 | 참관 방장 / 교사 |
|---|---|---|---|
| `me.card` | 분류 + 제시어 | 분류 + 역할 (**제시어 키 없음**) | `null` |
| `me.myVote` | 내 표 | 내 표 | `null` |
| `me.canGuess` / `me.guessSubmitted` | `false` | 최종 추측 중·제출 여부 | `false` |
| `votedCount` / `voterTotal` | 숫자만 | 숫자만 | 숫자만 |
| `reveal.votes`·`voteResult` | 1단계부터 | 1단계부터 | 1단계부터 |
| `reveal.fakeArtistId`·`caught` | 2단계부터 | 2단계부터 | 2단계부터 |
| `reveal.finalGuess` | 3단계부터 | 3단계부터 | 3단계부터 |
| `reveal.word`·`guessCorrect`·`outcome` | 4단계부터 | 4단계부터 | 4단계부터 |

진행권을 가진 방장도 예외가 아니다 — 결과는 공개하는 순서대로만 받는다.

## 상태 머신

```
LOBBY → PROMPT_SELECTION → PLAYING → REVEAL_READY → REVEALING → FINISHED → LOBBY (다시 시작)
                                  (어디서든 권한 있는 종료 → CLOSED)

가짜 예술가 찾기:
LOBBY → ROLE_REVEAL → DRAWING(×2N) → DISCUSSION(0초면 생략) → VOTING → FINAL_GUESS(항상 20초)
      → REVEAL_READY → REVEALING(0~3단계) → FINISHED(4단계) → LOBBY (다시 하기)
```

- 가짜 예술가 찾기의 단계 전환은 `fa.phaseId`(그리기에서는 차례 ID 를 겸함) 기준으로 한 번만 일어난다. 요청을 처리하기 전에 지난 기한부터 따라잡는다.

- 단계 전환은 `stageId` 를 기준으로 한 번만 일어난다 (전원 제출 ∨ 알람 ∨ 늦은 요청 처리 시 기한 확인).
- `version`: 방 상태 버전. 설정 변경·시작·다시 시작 명령은 `expectedVersion` 을 요구한다.
- `reveal.revision`: 공개 위치 버전. 공개 명령은 `expectedRevision` 을 요구하며 낮은 값은 거부된다.
- `RoomSummary.revision`: 클래스에 전달되는 요약의 버전. 지연·중복 통지는 무시된다.

## 데이터 모델 (요약)

| 모델 | 위치 | 비고 |
|---|---|---|
| TeacherSession | DirectoryObject `sessions` | 12시간 |
| Class | ClassObject KV `meta` + DirectoryObject `classes` 색인 | |
| ClassMember | ClassObject `members` | `token_hash`, `host_grant`(HostGrant), `current_room_id` |
| RoomSummary | ClassObject `rooms` | RoomObject 가 revision 과 함께 통지 |
| RoomMembershipReservation | ClassObject `reservations` | 20초 만료, 알람으로 대조 |
| Room / RoomMember / Game / RevealState | RoomObject KV `room` | 한 판의 배정·제출 목록·공개 위치 |
| Book / Entry | RoomObject `entries` | PK (game_id, book_id, idx) |
| Draft | RoomObject `drafts` | PK (game_id, stage_id, user_id), revision |
| outbox | Class/Room 각각 | DO 간 통지 재시도 큐 |
