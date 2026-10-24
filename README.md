# 운동 기록 · 칼로리 트래커 (PWA)

운동 종류 / 중량(kg) / 횟수 / 세트를 날짜별로 기록하고 소모 칼로리를 추정하는 모바일 웹앱입니다.
빌드 과정 없이 정적 파일만으로 동작하며, 데이터는 기기 브라우저(localStorage)에 저장됩니다.

## 기능
- 날짜별 운동 기록 (kg × 회 × 세트 빠른 입력, 세트별 개별 수정, 지난 기록 자동 불러오기)
- 유산소·플랭크 등 시간형 운동 (분, km)
- 운동별/일별 칼로리 추정 (MET + 중량 보정), 볼륨, 추정 운동시간
- 통계: 7일/30일 칼로리 차트, 월간 캘린더, 개인 기록(최고 중량, Epley 추정 1RM)
- 운동 목록: 부위별 기본 운동 40종 + 직접 추가/수정/삭제 (MET, ROM, 체중 반영 비율)
- 백업: JSON 내보내기/가져오기, CSV 내보내기
- 오프라인 동작, 홈 화면에 추가 가능 (PWA)

## 칼로리 계산식
1. 기본: `MET × 체중 × 운동시간(h)` + 휴식 `1.5 × 체중 × 휴식시간(h)`
   - 운동시간 = 총 반복수 × 1회 소요시간(기본 3초), 휴식시간 = 세트 수 × 휴식(기본 90초)
2. 중량 보정: `(중량 + 체중×체중반영비율) × 9.81 × ROM(m) × 반복수 ÷ 근육효율(25%) ÷ 4184`
3. 시간형: `MET × 체중 × 분/60`

MET 값은 Compendium of Physical Activities를 참고한 추정치입니다.

## 실행
```
python3 -m http.server 8000
```
GitHub Pages / Netlify / Vercel 등 정적 호스팅에 폴더째 올리면 휴대폰에서 접속 후 "홈 화면에 추가"로 설치할 수 있습니다.

## 배포 (GitHub Pages)
Settings → Pages → Build and deployment → Source: **Deploy from a branch**, Branch: **main / (root)**.
배포 주소: https://moonson000-star.github.io/workout-tracker/
