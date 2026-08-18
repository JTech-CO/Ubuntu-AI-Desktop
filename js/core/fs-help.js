/**
 * js/core/fs-help.js — the Korean help document that becomes ~/Desktop/help.txt.
 *
 * Plain text, laid out for a terminal: rule lines, aligned command columns, no
 * markdown. Hangul is double-width in a monospace terminal, so every column
 * here is aligned by visual width rather than character count — the left-hand
 * column of each table is ASCII precisely so that padding stays predictable,
 * and Korean prose always comes last on its line.
 *
 * The rule lines are 66 box-drawing characters rather than 78. Ubuntu Mono has
 * no U+2500/U+2550 glyphs, so the terminal falls back to another face where
 * they are wider than an ASCII cell; 66 of them come out the same width as the
 * 78-column body text instead of overhanging it.
 *
 * The command list is not guesswork: it was taken from the live registration
 * table (every commands/*.js default export plus builtins.js) and the counts
 * quoted in the document are the counts that table reports.
 */

/** @type {string} the contents of ~/Desktop/help.txt */
export const HELP_TXT = `
Ubuntu AI Desktop  —  도움말
══════════════════════════════════════════════════════════════════

이 파일은 ~/Desktop/help.txt 입니다.

  터미널에서    cat ~/Desktop/help.txt
  넘겨 가며     less ~/Desktop/help.txt
  찾아보며      grep -n "키워드" ~/Desktop/help.txt

바탕화면에서 두 번 클릭하면 텍스트 편집기로도 열립니다.


1. 이게 뭔가요
──────────────────────────────────────────────────────────────────

Ubuntu 24.04 LTS(Noble Numbat) 데스크톱을 브라우저 안에서 통째로
재현한 에뮬레이터입니다.

  * 완전한 정적 사이트입니다. GitHub Pages에 파일을 올리기만 하면
    그대로 동작합니다.
  * 빌드 과정이 없습니다. 번들러도, npm도, 트랜스파일도 없습니다.
    브라우저가 읽는 파일이 곧 저장소에 있는 파일입니다.
  * 서버가 없습니다. 모든 계산은 여러분의 브라우저 탭 안에서
    일어납니다. Gemini API를 부를 때를 제외하면 네트워크 요청이
    아예 나가지 않습니다.
  * 네이티브 ES 모듈과 순수 CSS로만 만들어졌습니다.

가상 머신은 아닙니다. 커널도 없고 실제 프로세스도 없습니다.
대신 진짜 파일시스템 하나, 진짜 bash 스타일 셸 하나, 그리고 그
파일시스템을 함께 쓰는 앱 열 개가 있습니다. 터미널에서 만든 파일이
파일 관리자에 정말로 나타나고, 편집기에서 열리고, 지우면 정말로
휴지통으로 들어갑니다.


2. 어디까지 진짜인가
──────────────────────────────────────────────────────────────────

이 프로젝트의 규칙은 하나입니다. 모르는 것은 모른다고 말한다.
그럴듯한 값으로 빈칸을 메우는 대신, 알 수 없는 값은 알 수 없다고
출력합니다. 아래가 그 경계선입니다.

  진짜인 것
  ─────────

  가상 파일시스템
      트리, 권한(8진수 모드), 소유자, mtime, 심볼릭 링크, 하드 링크,
      freedesktop.org 규격의 휴지통까지 갖춘 진짜 파일시스템입니다.
      모든 앱이 이 하나를 공유하고 localStorage에 저장됩니다.

  bash 스타일 셸
      switch 문으로 명령 이름을 분기하는 물건이 아닙니다. 따옴표와
      이스케이프를 제대로 처리하는 토크나이저, bash와 같은 순서의
      확장(틸드 → 파라미터 → 명령 치환 → 단어 분리 → 글로빙),
      파이프라인 AST, 서브셸까지 있습니다.
      지원: |  >  >>  <  2>  2>&1  &&  ||  ;  후행 &
            $VAR  ${'${VAR}'}  ${'${VAR:-기본값}'}  $?  $(...)  백틱
            *  ?  [abc]  ~  별칭  그리고 $?로 전파되는 종료 코드

  GNU 도구의 실제 출력 형식
      ls의 열 정렬, ps aux의 칼럼 폭, free -h의 자릿수, systemctl의
      유닛 표까지 진짜 도구가 찍는 모양 그대로입니다. 오류 문구도
      마찬가지입니다. 예를 들어 없는 파일을 열면 정확히
      "ls: cannot access 'foo': No such file or directory" 가 나옵니다.

  isatty(1) 동작
      명령이 자기 출력이 터미널인지 파이프인지 구분합니다. 그래서
      ls는 프롬프트에서는 여러 열로, 파이프하면 한 줄에 하나씩
      출력합니다. ls | wc -l 이 파일 개수를 제대로 셉니다.

  진짜 파일 내용
      /etc/os-release, /etc/lsb-release, /etc/passwd, /etc/group,
      /etc/shells, /etc/fstab, /etc/resolv.conf, /etc/issue 는 진짜
      Ubuntu 24.04.1 LTS의 내용입니다. /proc/cpuinfo, /proc/meminfo,
      /proc/uptime, /proc/loadavg 는 프로세스 표에서 즉석으로
      만들어지므로 볼 때마다 값이 움직입니다.

  창 관리자
      8방향 리사이즈, 가장자리 스냅(위로 끌면 최대화, 좌우로 끌면
      반쪽 타일링), 반투명 미리보기, 헤더 더블클릭 최대화,
      Alt+Tab 순환, 계단식 배치까지 GNOME이 하는 대로 합니다.

  Yaru 테마와 GNOME 46 레이아웃
      시계는 GNOME이 실제로 두는 위치인 상단 바 한가운데 있고,
      창 버튼은 오른쪽에 최소화·최대화·닫기 순서로 놓입니다.
      Yaru 액센트 열 가지, 우분투 오렌지 #E95420, gnome-terminal의
      진짜 배색(#300a24 배경)을 그대로 씁니다.

  진짜 호스트 하드웨어 정보
      About 화면, lscpu, nproc, arch, xrandr, xdpyinfo, glxinfo,
      inxi, getconf, dpkg-architecture, upower 는 지금 이 브라우저가
      알려주는 실제 값을 보고합니다. 코어 수, 화면 해상도, 실제로
      측정한 주사율, GPU 문자열, CPU 아키텍처, 배터리 잔량입니다.
      브라우저가 알려주지 않는 값(모니터의 물리적 크기, CPU 모델명,
      드라이버 버전)은 지어내지 않고 모른다고 적습니다.


  시뮬레이션인 것
  ───────────────

  커널이 없습니다
      리눅스 커널도, 시스템 콜도 없습니다. 명령은 ELF 바이너리가
      아니라 브라우저가 불러온 JavaScript 모듈입니다. 그래서
      strace는 추적을 거부하고 그 이유를 설명하며, ldd는 어떤
      파일에 대해서도 "not a dynamic executable"이라고 답합니다.
      두 대답 모두 사실입니다.

  실제 프로세스가 없습니다
      ps, top, kill, pidof, 시스템 모니터가 읽는 프로세스 표는
      1초마다 갱신되는 모사입니다. 실제 우분투 세션의 데몬 목록을
      본떠 만들었고 CPU·메모리 값이 그럴듯한 범위 안에서 움직이며
      부하 평균도 커널과 같은 방식으로 지수 평활합니다. 창을 열면
      정말로 프로세스가 하나 생기고 닫으면 사라지지만, 그 안에서
      실행되는 코드는 없습니다.

  apt는 가상 아카이브입니다
      패키지 데이터베이스는 저장소 안에 들어 있는 표입니다. 다만
      설치 동작은 진짜입니다. apt install 은 정말로 /usr/bin 아래에
      파일을 만들고, 그래서 which가 그 뒤로 찾아냅니다.
      apt remove 는 그 파일을 지우고, /var/log/dpkg.log 에 기록이
      남습니다. sudo 없이 실행하면 진짜 dpkg 잠금 오류가 나옵니다.
      하지만 그 파일은 표식일 뿐 실행 가능한 코드가 아닙니다.

  네트워크 명령은 모사입니다
      ping, curl, wget, dig, traceroute, nslookup 은 결정론적인
      가짜 응답을 돌려줍니다. 같은 이름은 항상 같은 주소로 풀리고,
      문법이 틀린 이름은 진짜처럼 NXDOMAIN이 됩니다.
      페이지 밖으로 나가는 유일한 통신은 Gemini API 호출뿐입니다.

  Code - OSS의 Run은 AI 해석입니다
      셸 스크립트는 진짜 터미널 엔진으로 실행됩니다. 그 밖의 언어는
      Gemini에게 보내 결과를 예측하게 하고, 출력 패널에 "AI가
      시뮬레이션한 결과"라고 분명히 표시합니다. API 키가 없으면
      결과를 지어내는 대신 없다고 말합니다.

  Firefox는 시뮬레이션 브라우저입니다
      임의의 사이트로 실제 요청을 보내지 않습니다. 검색 결과와
      페이지는 Gemini가 만들며 모든 화면에 그렇다고 표시됩니다.

  그 밖에 일부러 남겨 둔 한계
      bc 는 JavaScript 배정밀도를 쓰므로 scale이 소수점 15자리
      근처까지만 정확하고 define/if/while/for 는 없습니다.
      yes 는 탭이 멈추지 않도록 속도 제한과 100만 줄 상한이 있습니다.
      xxd -r (역변환)은 구현되어 있지 않습니다.
      화면의 물리적 크기(mm)는 EDID를 읽을 수 없어 xrandr에서
      0mm x 0mm 로 나옵니다. 이는 EDID가 없는 진짜 모니터에서
      xrandr이 찍는 값과 같습니다.


3. 들어 있는 앱 (10개)
──────────────────────────────────────────────────────────────────

  Terminal — 터미널
      탭을 지원하는 gnome-terminal. 아래 4장의 명령을 전부 실행하는
      진짜 셸이 들어 있습니다. 기록은 ~/.bash_history 에 남고
      Ctrl+R 역방향 검색과 Emacs 편집키를 지원합니다.

  Files — 파일 (Nautilus)
      격자·목록 두 가지 보기, 경로 breadcrumb, 사이드바, 다중 선택,
      잘라내기·복사·붙여넣기, 되돌리기, 드래그 앤 드롭, 이름 바꾸기,
      속성, 휴지통. 모든 동작이 가상 파일시스템을 직접 건드립니다.

  Firefox — 웹 브라우저
      탭, 뒤로·앞으로, 주소 표시줄, 북마크, 방문 기록.
      검색 결과와 페이지는 Gemini가 만들며 그렇다고 표시됩니다.

  Text Editor — 텍스트 편집기
      탭 문서, 수정 표시(•), 찾기·바꾸기, 줄 번호, 자동 줄바꿈.
      Ctrl+S / Ctrl+O / Ctrl+N / Ctrl+W / Ctrl+F.

  Image Viewer — 이미지 뷰어
      파일시스템의 이미지를 열어 확대·축소·회전하고 넘겨 봅니다.
      스크린샷을 찍으면 이 앱으로 열립니다.

  Code - OSS — 코드 편집기
      VS Code 형태의 편집기. 파일 트리, 탭, 줄 번호,
      토크나이저 기반 문법 강조(문자열과 주석을 먼저 잘라내므로
      문자열 안의 키워드가 잘못 칠해지지 않습니다), 자동 들여쓰기,
      괄호 짝 맞추기, 통합 터미널, 그리고 Gemini 에이전트 패널.

  System Monitor — 시스템 모니터
      프로세스 / 리소스 / 파일 시스템 세 탭. 정렬 가능한 프로세스
      표, 코어별 CPU·메모리·네트워크 실시간 차트(HiDPI 대응),
      마운트 목록.

  Settings — 설정
      Wi-Fi, 네트워크, 블루투스, 배경, 모양(밝게·어둡게, Yaru 액센트
      10종, 독 위치·크기·자동 숨김), 알림, 검색, 멀티태스킹, 소리,
      전원, 디스플레이, 키보드 단축키, 사용자, 날짜와 시간,
      정보(실제 하드웨어), 그리고 AI 설정.

  Calculator — 계산기
      기본·고급 모드, 키보드 입력, 계산 기록. 진짜 수식 파서 사용.

  Trash — 휴지통
      freedesktop.org 규격 휴지통. 항목별 복원과 영구 삭제,
      비우기 확인 대화상자.


4. 키보드 단축키
──────────────────────────────────────────────────────────────────

  Super                  현재 활동 화면(Activities) 열고 닫기
  Super + A              모든 프로그램 보기
  Super + S              시스템 메뉴 열기
  Super + V              알림 목록 열기
  Super + D              모든 창 숨기기 / 되돌리기
  Super + L              화면 잠금 (암호: ubuntu)
  Super + Left / Right   화면 왼쪽 / 오른쪽 절반에 타일링
  Super + Up / Down      최대화 / 이전 크기로
  Alt + Tab              창 전환
  Alt + Shift + Tab      역방향 창 전환
  Alt + F2               명령 실행 대화상자 (아래 참고)
  Alt + F4               창 닫기
  Ctrl + Alt + T         새 터미널
  Print                  스크린샷
  Esc                    (키보드 잠금 중) 에뮬레이터 밖으로 나가기 — 확인 후

  ─ 키보드 잠금 ────────────────────────────────────────────────

  Ctrl+T, Ctrl+W, Ctrl+N 같은 키는 원래 브라우저가 먼저 가져갑니다.
  그래서 아무것도 하지 않으면 Code-OSS 나 편집기에서 Ctrl+W 를 눌렀을 때
  앱의 탭이 아니라 이 페이지를 띄운 진짜 크롬 탭이 닫힙니다.
  웹 페이지가 그 키를 가로챌 수 있는 방법은 Keyboard Lock API 하나뿐이고,
  그것은 전체화면일 때만 동작합니다.

  켜는 법
      상단 막대 왼쪽의 "키보드 잠그기" 를 누르거나,
      처음 부팅할 때 아래에 뜨는 안내에서 잠그기를 누르세요.
      (전체화면 전환은 반드시 사용자의 클릭이 있어야 하므로
       자동으로는 켤 수 없습니다.)

  켜지면
      Ctrl+T 는 터미널·편집기·Code-OSS 의 새 탭을,
      Ctrl+W 는 그 탭 닫기를 실제로 수행합니다.

  나가는 법 — 셋 중 아무거나
      1. Esc 한 번         → "나갈까요?" 확인 후 해제
                             (메뉴나 대화상자가 열려 있으면 그걸 먼저 닫습니다)
      2. Esc 2초간 길게    → 브라우저가 강제로 해제. 이건 브라우저가
                             보장하는 탈출구라 끌 수 없습니다.
      3. 좌측 상단 전원 버튼 → 컴퓨터 끄기. 확인 없이 즉시 키보드를 돌려줍니다.

  제약
      Chromium 계열(Chrome, Edge, Opera)에서만 됩니다.
      Firefox 와 Safari 에는 Keyboard Lock API 가 없어서,
      그 브라우저에서는 이 기능이 비활성으로 표시됩니다.
      https:// 또는 localhost 에서 열어야 합니다.

  터미널 안에서
  Ctrl + Shift + T       새 탭
  Ctrl + Shift + C / V   복사 / 붙여넣기
  Ctrl + C               실행 중인 명령 중단
  Ctrl + D               입력 끝 (빈 줄에서는 셸 종료)
  Ctrl + L               화면 지우기
  Ctrl + A / E           줄 처음 / 끝으로
  Ctrl + U / K / W       커서 앞 / 뒤 / 앞 단어 지우기
  Ctrl + R               기록 역방향 검색
  Alt + B / F            한 단어 뒤로 / 앞으로
  Tab                    명령과 경로 자동 완성
  Up / Down              명령 기록

  Alt + F2 — 명령 실행 대화상자
      GNOME의 그 상자입니다. 화면 위쪽에 입력칸 하나만 뜹니다.
      Tab을 누르면 회색으로 미리 보이는 나머지가 채워지고,
      Enter로 실행, Escape 또는 바깥 클릭으로 닫힙니다.
      찾을 수 없는 명령이면 GNOME처럼 빨간 밑줄이 그어집니다.
      앱 이름(files, 터미널의 gnome-terminal 같은 런처 이름 포함)을
      넣으면 그 앱이 열리고, 그 밖의 것은 셸로 실행되어 결과가
      알림으로 표시됩니다.
      r 또는 restart 는 셸을 다시 시작하고, lg 는 Looking Glass —
      열린 창, 프로세스 표, 파일시스템 통계, localStorage 사용량을
      한 화면에 보여 주는 디버그 화면을 엽니다.


5. 명령어 전체 목록
──────────────────────────────────────────────────────────────────

외부 명령 176개와 셸 빌트인 24개, 모두 200개가 등록되어 있습니다.
별칭까지 세면 터미널이 아는 이름은 212개입니다.
살아 있는 목록은 help, 자세한 설명은 man <명령어> 로 볼 수 있습니다.


  파일과 디렉터리 (26)
  ────────────────────
  ls                  디렉터리 내용 나열 (파이프하면 한 줄에 하나씩)
  cd                  디렉터리 이동 (빌트인)
  mkdir               디렉터리 만들기 (-p 로 중간 경로까지)
  rmdir               빈 디렉터리 지우기
  rm                  파일·디렉터리 지우기 (-r -f -i)
  cp                  복사하기 (-r -a -v)
  mv                  옮기기, 이름 바꾸기
  touch               빈 파일 만들기, 시각 갱신
  ln                  링크 만들기 (-s 심볼릭)
  cat                 파일을 이어 출력 (-n 줄 번호)
  tac                 파일을 거꾸로 출력
  head                앞부분만 (-n 줄 수, -c 바이트)
  tail                뒷부분만 (-n, -f 따라가기)
  wc                  줄·단어·바이트 세기
  find                조건으로 찾기 (-name -type -exec)
  tree                디렉터리 트리 그리기
  du                  차지한 용량 (-h -s)
  df                  파일시스템 여유 공간 (-h)
  stat                파일 메타데이터 자세히
  file                내용을 보고 파일 종류 짐작
  chmod               권한 바꾸기 (기호·8진수 모두)
  chown               소유자 바꾸기 (root 필요)
  realpath            링크를 모두 푼 절대 경로
  basename            경로에서 이름만 떼기
  dirname             경로에서 디렉터리만 떼기
  readlink            심볼릭 링크가 가리키는 곳
  mktemp              임시 파일·디렉터리 만들기

  텍스트 다루기 (23)
  ──────────────────
  echo                인자를 그대로 출력 (-n -e)
  printf              C 스타일 서식 출력
  grep                정규식 검색 (-i -v -n -r -E)
  egrep               grep -E 와 같음
  fgrep               grep -F 와 같음 (고정 문자열)
  sed                 스트림 편집 (s/// d p, -i 제자리 수정)
  sort                정렬 (-n -r -k -u)
  uniq                이어진 중복 줄 처리 (-c -d)
  cut                 열 잘라내기 (-d -f -c)
  tr                  문자 치환·삭제 (-d -s)
  rev                 각 줄을 좌우로 뒤집기
  tee                 화면과 파일에 동시에 쓰기
  diff                두 파일 비교 (-u 통합 형식)
  nl                  줄 번호 매기기
  less                한 화면씩 넘겨 보기
  more                간단한 페이저
  paste               파일들을 옆으로 붙이기
  column              입력을 열 맞춘 표로
  fold                지정한 폭에서 줄 접기
  split               파일을 여러 조각으로
  join                공통 필드로 두 파일 합치기
  comm                정렬된 두 파일의 공통·차집합
  shuf                줄 순서를 무작위로

  시스템 정보 (22)
  ────────────────
  uname               커널과 시스템 정보 (-a -r -m)
  arch                하드웨어 아키텍처 — 호스트 실제 값
  nproc               쓸 수 있는 코어 수 — 호스트 실제 값
  whoami              지금 사용자 이름
  id                  사용자·그룹 ID
  groups              소속 그룹
  hostname            호스트 이름 (-I 주소)
  uptime              가동 시간과 부하 평균
  date                날짜·시각 출력과 서식 (+FORMAT)
  cal, ncal           달력
  free                메모리·스왑 사용량 (-h)
  which               실행 파일 경로 찾기
  whereis             바이너리·소스·맨페이지 위치
  man                 매뉴얼 페이지 보기
  sudo                관리자 권한으로 실행 (암호: ubuntu)
  su                  다른 사용자로 셸 바꾸기
  tty                 지금 터미널 장치 이름
  stty                터미널 설정 보기
  locale              로케일 환경 변수
  lsb_release         배포판 정보 (-a)
  hostnamectl         호스트 정보 보기·바꾸기
  timedatectl         시각과 시간대 설정

  하드웨어와 서비스 (11)
  ──────────────────────
  lscpu               CPU 정보 — 코어 수는 호스트 실제 값
  lsblk               블록 장치 트리
  lsusb               USB 장치 목록
  lspci               PCI 장치 목록
  lsmod               적재된 커널 모듈
  mount               마운트된 파일시스템
  dmesg               커널 링 버퍼 로그
  systemctl           유닛 상태 조회, 시작, 중지
  journalctl          systemd 저널 (-u 유닛, -f 따라가기)
  systemd-analyze     부팅 시간 분석 — userspace는 실제 로드 시간
  resolvectl          systemd-resolved 상태와 이름 질의

  프로세스 (7)
  ────────────
  ps                  프로세스 목록 (aux, -ef)
  top                 실시간 프로세스 모니터
  kill                시그널 보내기
  pkill               이름으로 시그널 보내기
  killall             같은 이름 프로세스 모두 종료
  pidof               이름으로 PID 찾기
  pgrep               패턴으로 PID 찾기

  성능과 진단 (6)
  ───────────────
  vmstat              가상 메모리·CPU 통계 (숫자가 크면 자동 확장)
  iostat              CPU와 장치 I/O 통계
  lsof                열린 파일 목록
  fuser               파일·포트를 쓰는 프로세스 (-k 로 종료까지)
  strace              시스템 콜 추적 — 불가능한 이유를 설명하고 거부
  ldd                 공유 라이브러리 의존성 — ELF가 없으므로 항상 아님

  디스플레이와 그래픽 (4)
  ───────────────────────
  xrandr              화면 구성 — 실제 해상도와 측정한 주사율
  xdpyinfo            X 서버·화면 정보 — 실제 크기, 96dpi 환산 mm
  glxinfo             OpenGL 렌더러 문자열 — 실제 GPU (-B 요약)
  inxi                시스템 요약 (-b 기본, -F 전체)

  데스크톱 설정 (6)
  ─────────────────
  gsettings           GSettings 키 읽기·쓰기 — 데스크톱에 즉시 반영
  dconf               dconf 데이터베이스에 경로로 직접 접근
  xdg-user-dir        XDG 사용자 디렉터리 경로
  xdg-mime            파일 형식과 기본 앱 조회·설정
  xdg-open            파일·URL을 알맞은 앱으로 열기
  rfkill              무선 스위치 — 설정의 Wi-Fi·블루투스와 연동

  전원과 계정 (10)
  ────────────────
  upower              전원·배터리 — 호스트의 실제 배터리를 읽음
  w                   로그인한 세션과 하는 일
  users               로그인한 사용자 이름
  last                로그인 기록
  lastlog             계정별 마지막 로그인
  passwd              암호 바꾸기 — 저장할 곳이 없음을 설명하고 중단
  adduser             사용자 추가 — 계정 표가 고정이라 거부
  useradd             사용자 추가 (저수준) — 마찬가지
  crontab             크론탭 설치·편집 (파일은 진짜, 실행은 되지 않음)
  getconf             POSIX 설정 값 — 코어 수는 호스트 실제 값

  네트워크 (14, 모두 모사)
  ────────────────────────
  ping                왕복 시간 측정
  ifconfig            구식 인터페이스 설정 도구
  ip                  주소·경로·링크 (ip a, ip r, ip link)
  netstat             소켓, 경로, 통계
  ss                  소켓 상태 (netstat의 후계)
  curl                URL 전송 — Gemini 외에는 모사 응답
  wget                파일 내려받기 — 모사
  dig                 DNS 조회 자세히
  nslookup            간단한 DNS 조회
  host                이름과 주소 변환
  traceroute          경로 추적 (별칭: tracepath)
  arp                 ARP 캐시
  route               라우팅 표
  nmcli               NetworkManager 명령행 도구

  패키지 (9)
  ──────────
  apt                 설치·삭제·검색·업그레이드 (가상 아카이브)
  apt-get             구형 apt 인터페이스
  apt-cache           패키지 메타데이터 조회
  dpkg, dpkg-query    설치된 패키지 직접 다루기
  snap                스냅 패키지
  add-apt-repository  PPA 추가 (별칭: apt-add-repository)
  do-release-upgrade  배포판 업그레이드
  dpkg-architecture   데비안 아키텍처 변수 — 실제 아키텍처
  update-alternatives 기본 프로그램 대안 관리

  AI (7, API 키 필요)
  ───────────────────
  ai, ask, gemini     Gemini에게 물어보기
  explain             직전 명령과 그 출력을 설명
  gencode             설명을 코드로 만들기
  summarize           입력 요약 (별칭: summarise)
  translate           번역

  앱 열기 (13)
  ────────────
  nano, vim, vi       텍스트 편집기 창 열기
  gedit               텍스트 편집기 창 열기 (별칭: gnome-text-editor)
  code                Code - OSS 열기
  nautilus            파일 관리자 열기 (별칭: gnome-files)
  firefox             브라우저 열기
  eog                 이미지 뷰어 열기 (별칭: gnome-image-viewer, eom)
  gnome-screenshot    화면 캡처 (별칭: import)

  그 밖 (18)
  ──────────
  sleep               지정한 시간 기다리기
  seq                 수열 출력
  yes                 같은 줄 반복 (안전 상한 있음)
  bc                  계산기 (JavaScript 배정밀도)
  md5sum              MD5 체크섬
  sha256sum           SHA-256 체크섬
  base64              base64 인코딩·디코딩
  xxd                 16진 덤프 (-r 역변환은 미구현)
  watch               명령을 주기적으로 반복
  time                명령 실행 시간 재기
  cowsay              말하는 소
  cowthink            생각하는 소
  figlet              큰 글자 배너
  banner              굵은 배너
  fortune             격언 한 줄
  reboot              다시 시작
  poweroff, halt      전원 끄기
  shutdown            예약 종료

  에뮬레이터 전용 (2)
  ──────────────
  이 두 개는 실제 우분투에 없거나 다르게 동작합니다.

  reset               이 컴퓨터를 공장 초기화 — 파일시스템, 배경화면,
                      강조색, 테마, 독 설정, 창 배치, 방문 기록, 북마크,
                      셸 기록, 휴지통을 모두 원본으로 되돌립니다.
                      되돌릴 수 없고, 끝나면 페이지가 새로 고쳐집니다.
                      Gemini API 키는 유지되며 --all 을 붙이면 함께 지웁니다.
                      -y 를 붙이면 확인을 건너뜁니다.
                        주의 — 진짜 우분투의 reset(1) 은 파일을 건드리지 않고
                        망가진 터미널을 되살리는 명령입니다. 화면만 지우려면
                        clear 나 Ctrl+L 을 쓰세요.

  github              화면이 한 번 번쩍인 뒤 파이어폭스가 저절로 열리고,
                      주소창에 github.com 이 한 글자씩 입력되고 엔터까지
                      눌립니다. 누군가 이 컴퓨터를 원격으로 조작하는 것처럼
                      보이는 연출입니다.
                        도착하는 페이지는 에뮬레이터가 직접 그린 화면입니다.
                        github.com 은 X-Frame-Options 헤더로 다른 페이지 안에
                        삽입되는 것을 거부하므로, 브라우저 탭 안에서 진짜
                        github.com 을 띄우는 것은 불가능합니다. 화면에도
                        그렇게 적혀 있습니다.
                        페이지가 뜨면 Enter 를 눌러 실제
                        https://jtech-co.github.io/ 로 이동합니다. 이때는
                        에뮬레이터를 벗어나 이 브라우저 탭이 그 주소로
                        바뀝니다. Esc 를 누르면 취소합니다.

  셸 빌트인 (24)
  ──────────────
  셸의 상태를 직접 바꾸기 때문에 외부 명령이 아니라 셸 안에
  들어 있습니다. type <이름> 으로 확인할 수 있습니다.

  cd                  디렉터리 이동
  pwd                 지금 디렉터리 출력
  export              환경 변수 설정과 내보내기
  unset               변수 해제
  alias               별칭 정의와 나열
  unalias             별칭 해제
  source, .           스크립트를 지금 셸에서 실행
  exit                셸 끝내기
  logout              로그인 셸 끝내기
  history             명령 기록
  jobs                작업 목록
  fg                  작업을 앞으로
  bg                  작업을 뒤로
  wait                자식 작업 기다리기
  set                 셸 옵션과 위치 인자
  shopt               셸 동작 옵션
  type                이름의 종류 판별
  command             별칭·함수를 건너뛰고 실행
  eval                인자를 명령으로 실행
  help                빌트인 도움말
  true                참(0) 돌려주기
  false               거짓(1) 돌려주기
  :                   아무것도 하지 않음 (참)

  미리 정의된 별칭
  ────────────────
  ~/.bashrc 에서 진짜로 읽어 들입니다. 직접 고치면 새 탭부터
  적용됩니다.

  ll = ls -alF        la = ls -A        l = ls -CF
  grep, fgrep, egrep 은 --color=auto 가 붙습니다.


6. AI 기능과 API 키
──────────────────────────────────────────────────────────────────

ai, ask, explain, gencode, summarize, translate 명령과 Code - OSS의
에이전트 패널, Firefox의 검색 결과는 Google Gemini API를 브라우저에서
직접 호출합니다.

  키 받기      https://aistudio.google.com/apikey
  키 넣기      설정 → AI Configuration 에 붙여넣기
  저장 위치    이 브라우저의 localStorage, 키 이름 uad:apikey

키가 없어도 나머지 기능은 전부 동작합니다.


  보안 경고 — 배포하기 전에 꼭 읽어 주세요
  ────────────────────────────────────────

  * 저장소에 API 키를 커밋하지 마세요. 페이지에 박아 넣지도 마세요.
    GitHub Pages 사이트는 공개이고 압축되어 있지도 않습니다. 누구나
    소스나 네트워크 탭에서 키를 그대로 읽어 갈 수 있습니다.
    .gitignore 가 key.txt, *.key, .env 를 막고 있는 이유입니다.

  * 키는 방문자 각자의 localStorage 에 저장됩니다. 방문자는 자기
    키를 넣어 쓰므로 남의 사용량을 여러분이 결제하지 않습니다.

  * localStorage 는 같은 출처의 어떤 스크립트든 읽을 수 있습니다.
    "다른 웹사이트로부터는 안전하지만, 이 브라우저 앞에 앉은
    사람으로부터는 안전하지 않다"고 생각하세요.

  * Google AI Studio에서 키에 HTTP 리퍼러 제한을 거세요. 여러분의
    Pages 도메인만 허용해 두면 키가 새어 나가도 다른 곳에서는
    쓸 수 없습니다.

  * 한 번이라도 키를 커밋한 적이 있다면 반드시 새 키로 교체하세요.
    나중 커밋에서 파일을 지워도 git 기록에서는 사라지지 않습니다.


7. 초기화와 로컬 실행
──────────────────────────────────────────────────────────────────

  초기화
  ──────
  파일시스템과 설정은 localStorage 에 남습니다. 갓 설치한 상태로
  되돌리려면 브라우저 개발자 콘솔에서 다음을 실행하세요.

      UAD.reset()

  localStorage.clear(); location.reload() 도 동작하기는 합니다.
  다만 그건 언로드 처리기가 저장소가 비워졌는지 확인한 뒤에
  저장하도록 만들어 두었기 때문입니다. UAD.reset() 을 쓰세요.

  window.UAD 에는 fs, wm, procs, env, bus, store, gemini, metrics,
  notify, settings, apps 가 들어 있습니다. 콘솔에서 직접 만져 볼 수
  있고, Alt+F2 에서 lg 를 실행하면 같은 내용을 화면으로 봅니다.

  로컬에서 실행하기
  ─────────────────
  저장소 최상위에서 다음을 실행하고 http://localhost:8321 을 엽니다.

      python serve.py

  index.html 을 file:// 로 직접 여는 것은 동작하지 않습니다.
  ES 모듈은 file: 스킴이 만족시킬 수 없는 CORS 규칙으로 가져오기
  때문에, 데스크톱이 시작되기도 전에 브라우저가 모든 import 를
  거부합니다.

  아무 정적 HTTP 서버나 쓸 수 있지만 serve.py 를 함께 넣어 둔 이유가
  있습니다. Cache-Control: no-store 를 함께 보내기 때문입니다.
  모듈을 고치고 새로 고쳤는데 조용히 예전 코드가 도는 사고를
  막아 줍니다. python -m http.server 는 캐시 헤더를 전혀 보내지
  않아서 브라우저가 JavaScript 를 아주 공격적으로 캐시합니다.

  GitHub Pages 에 올리기
  ──────────────────────
  1. 이 디렉터리를 저장소에 올립니다.
  2. Settings → Pages → Build and deployment → Deploy from a branch
     에서 브랜치와 / (root) 폴더를 고릅니다.
  3. https://<사용자>.github.io/<저장소>/ 를 엽니다.

  밑줄로 시작하는 경로를 Jekyll 이 먹어 치우지 않도록 .nojekyll 을
  함께 커밋해 두었습니다. 그 밖에 필요한 것은 없습니다.
  index.html 의 모든 경로가 상대 경로라 하위 디렉터리에서도
  그대로 동작합니다.


8. 더 알아보기
──────────────────────────────────────────────────────────────────

  help                등록된 명령의 살아 있는 목록
  man <명령어>        그 명령의 전체 매뉴얼 (한계까지 적혀 있습니다)
  neofetch            로고와 시스템 요약
  inxi -b             하드웨어 요약
  cat /etc/os-release 진짜 Ubuntu 24.04.1 LTS 파일
  Alt+F2 에서 lg      Looking Glass 디버그 화면

  저장소 문서
  ───────────
  docs/ARCHITECTURE.md
      모든 모듈이 지키는 규범 문서
  README.md
      영문 개요와 확장 방법

══════════════════════════════════════════════════════════════════
sudo 암호와 잠금 화면 암호는 모두 ubuntu 입니다.
`;

export default HELP_TXT;
