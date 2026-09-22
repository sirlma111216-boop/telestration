# 일러스트 파일과 생성용 프롬프트

그림 3장은 `public/images/` 에 들어 있고 아래 화면에서 쓰입니다. **모두 선택 사항입니다.** 파일을 지우거나 로딩에 실패하면 그 자리에 아무것도 그리지 않고 레이아웃은 그대로 유지됩니다 (`Illustration` 컴포넌트가 `onError` 에서 스스로 사라집니다). 게임 중의 그림은 학생이 직접 그리므로 사전 생성하지 않습니다.

## 어느 화면에 들어가는가

| 파일 | 크기 | 들어가는 화면 | 표시 방식 |
|---|---|---|---|
| `friends.webp` | 1672×936 · 165KB | 학생 참여 화면(`/`, `/join/<코드>`)과 교사 로그인(`/teacher`) | 컴퓨터·태블릿에서 **오른쪽 칸**. 왼쪽은 입력창입니다. 휴대폰(768px 미만)에서는 숨깁니다. |
| `hero-bg.webp` | 1672×936 · 64KB | **로그인한 뒤** 화면들: 교사 대시보드, 교사 클래스 화면, 학생 클래스 로비, 게임방 대기실 | 화면 전체에 고정된 양옆 낙서 배경. 가운데가 비어 있어 본문이 그 위에 놓입니다. 휴대폰에서는 양옆이 잘리므로 숨깁니다. |
| `mascot.webp` | 1240×1240 · 48KB | 교사 대시보드에 클래스가 없을 때, 학생 로비에 열린 방이 없을 때, 게임방의 기다리는 화면(제시어 고르는 중·단계 진행 중·결과 공개 준비 중) | 가운데 정렬된 작은 그림(112~128px) |

두 가지 규칙이 있습니다.

- **로그인 전에는 양옆 낙서를 쓰지 않습니다.** 첫 화면은 입력창과 친구들 그림만 두어 무엇을 해야 하는지가 먼저 보이게 했습니다.
- **게임이 시작되면 양옆 낙서를 뺍니다.** 제시어 선택·그리기·추측·결과 공개 화면에서는 작업에 집중해야 하므로 배경 장식을 두지 않습니다. 대기실까지만 유지됩니다.

세 파일 모두 `loading="lazy"`, `decoding="async"` 이고, 배경 장식은 `aria-hidden` 이라 화면 낭독기가 읽지 않습니다. `friends.webp` 에는 설명(`alt`)이 붙어 있습니다.

## 다시 만들 때 쓰는 프롬프트

공통 스타일(영문):

> Warm cream paper background (#fdf8ef), dark navy ink outlines (#2b2f4a), accents in coral (#f4735f), mint (#6fcdb7) and lavender (#b7a4f2). Friendly hand-drawn doodle style, flat colors, no text, no watermark, generous empty space in the center for UI.

- **hero-bg**: "Border decoration of doodles for a classroom drawing game: small framed sketches (cat, banana with wings, robot), pencils, washi tape, confetti stars, on both left and right edges only; center completely empty."
- **mascot**: "A cute spiral notebook character with a shy smile hugging a big coral pencil, simple rounded shapes, centered."
- **friends**: "Four diverse teenagers sitting on the floor laughing while drawing on tablets and phones, a cat napping, small floating framed doodles above them; left third of the image empty."

## 바꾸거나 뺄 때

- 파일만 같은 이름으로 바꿔 넣으면 됩니다. 코드 수정은 필요 없습니다.
- `hero-bg` 는 가운데가 비어 있어야 합니다. 가운데에 그림이 있으면 본문과 겹칩니다. `object-contain` 으로 그리므로 화면 비율이 달라도 양옆 낙서가 잘리지 않습니다.
- 아예 빼려면 `public/images/` 에서 파일을 지우면 됩니다. 화면은 그대로 동작합니다.
- 배경을 넣거나 뺄 화면을 바꾸려면 `src/components/ui.tsx` 의 `PageBackdrop` 을 쓰는 곳을 고치면 됩니다.
