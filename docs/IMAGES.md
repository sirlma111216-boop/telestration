# 선택적 일러스트 파일과 생성용 프롬프트

앱은 이미지 없이 완성된 디자인으로 동작한다. 아래 파일이 `public/images/` 에 있으면 홈·대기실에 장식으로 쓸 수 있고, 없거나 로딩에 실패해도 레이아웃은 바뀌지 않는다 (현재 코드는 이미지를 참조하지 않으며, 사용하려면 `<img loading="lazy" onError={hide}>` 로 추가한다).

| 파일 | 용도 | 권장 크기 |
|---|---|---|
| `public/images/hero-bg.webp` | 홈 배경 장식 (양옆 낙서·종이) | 1664×936 |
| `public/images/mascot.webp` | 대기실·빈 상태 마스코트 | 1240×1240 |
| `public/images/friends.webp` | 홈 하단 일러스트 | 1664×936 |

공통 스타일 프롬프트(영문):

> Warm cream paper background (#fdf8ef), dark navy ink outlines (#2b2f4a), accents in coral (#f4735f), mint (#6fcdb7) and lavender (#b7a4f2). Friendly hand-drawn doodle style, flat colors, no text, no watermark, generous empty space in the center for UI.

- hero-bg: "Border decoration of doodles for a classroom drawing game: small framed sketches (cat, banana with wings, robot), pencils, washi tape, confetti stars, on both left and right edges only; center completely empty."
- mascot: "A cute spiral notebook character with a shy smile hugging a big coral pencil, simple rounded shapes, centered."
- friends: "Four diverse teenagers sitting on the floor laughing while drawing on tablets and phones, a cat napping, small floating framed doodles above them; left third of the image empty."

게임 중 그림은 학생이 직접 그리므로 사전 생성하지 않는다.
