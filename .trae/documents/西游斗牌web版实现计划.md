# 《西游斗牌》Web 版实现计划

## Context

游戏规则已定稿于 [游戏设计文档.md](file:///d:/yangf_file/Trea_Pro/Xiyouji_poker/游戏设计文档.md)（v0.2，规则唯一依据）。当前目录除该文档外无任何代码。目标：实现一个可玩的 Web 应用，3~6 人在同一局域网内通过手机/电脑浏览器访问 `http://电脑IP:3000` 实时对局（房主建房间、全员准备后开始、回合制压制、收牌惩罚、败牌最少者通杀）。

环境约束（已验证）：Windows 本机**无 Node/Python/Bun/Deno**，但 winget 可用。用户已同意自动安装 Node.js LTS。

v0.2 中 ⚠️ 项全部按建议默认值落定：同牌值不互压、能压制时也允许打功能牌、收牌含功能牌、收牌者先补牌、仅计败牌堆、摸牌堆耗尽后再次收牌即终局、并列通杀取座位最小者为下局先手。

## 技术选型

| 项 | 选型 |
|---|---|
| 运行时 | Node.js LTS（`winget install OpenJS.NodeJS.LTS`） |
| Web 服务 | Express 4（仅 `express.static` 托管前端） |
| 实时通信 | Socket.IO 4（内建房间/心跳/自动降级 polling，适配局域网 WiFi） |
| 前端 | 原生 HTML/CSS/JS 单页（零构建工具） |
| 测试 | Node 内置 `node:test`（零额外依赖） |
| 依赖 | 仅 `express` + `socket.io` |

服务端权威结算（洗牌、克制判定、收牌补牌、终局全在服务端，防作弊）。

## 文件结构

```
Xiyouji_poker/
├── 游戏设计文档.md          # 规则唯一依据（已存在，不改动）
├── package.json             # scripts: start / test
├── server.js                # 入口：静态托管、局域网 IP 打印、防火墙提示
├── lib/
│   ├── cards.js             # 纯函数：牌定义、组内序数、canBeat、洗牌、发牌、buildDeck
│   └── engine.js            # 纯逻辑：房间状态机、回合流转、收牌/补牌/终局/托管选择（无 socket 依赖）
├── net/
│   └── net.js               # 协议层：Socket.IO 事件接入 → engine → 按人定制广播
├── public/
│   ├── index.html           # 单页：房间/对局/结算三视图
│   ├── style.css            # 中国风样式，移动端优先
│   └── app.js               # 前端：socket 封装、三视图渲染与交互
└── test/
    ├── cards.test.js        # canBeat 全分支 + 牌堆完整性
    └── engine.test.js       # 回合流转/收牌/补牌/终局/先手
```

分层：`cards.js`（纯函数）→ `engine.js`（无 I/O 规则引擎）→ `net.js`（协议）→ `server.js`（进程入口）。日后拓展技能/组合牌只改 `cards.js`/`engine.js`。

## 核心设计

### 克制判定 canBeat(top, card)（lib/cards.js）

```js
const MONSTER_ORDER = { 4:1, 6:2, 7:3, 9:4, J:5, Q:6, K:7, SJ:8, BJ:9 };
const DISCIPLE_ORDER = { 3:1, 8:2, 5:3 };
const BEAT = { monster:'master', master:'disciple', disciple:'monster' }; // 环形克制

function canBeat(top, card) {
  if (!top) return true;                                // 空桌面任意可出
  if (top.kind==='action' || card.kind==='action') return false;
  if (top.kind === card.kind) { /* 同组严格更大（monster/disciple 查序数，master 恒 false）*/ }
  return BEAT[card.kind] === top.kind;                  // 跨组查克制矩阵
}
```

对照文档 §3.5 速查表逐行验证：妖怪压妖怪(大压小/同值不压)、师兄弟压任意妖怪(3 压大王为真)、唐僧压三师兄弟、任意妖怪压唐僧、功能牌隔离。另提供 `computeLegalMoves(room, pid)` 返回 `{opening, beatIds[], actionIds[]}`，同时用于 UI 高亮与服务端校验。

### 牌结构

`Card = { id: '3_♠_0', rank, suit, kind: 'monster'|'disciple'|'master'|'action' }`；deck 54 张 = 妖怪30(4/6/7/9/J/Q/K×4 + 王×2) + 师兄弟12(3/8/5×4) + 唐僧4(10×4) + 功能8(A/2×4)。

### 回合流转（lib/engine.js）

- `playCard`: 校验轮到/手牌/克制或功能 → 入 tablePile；A=门槛不变轮到下家；2=方向取反轮到新方向上家；普通牌=成为新 topCard 轮到下家。`resolveNext` 跳过空手牌者，全场手牌空→终局。
- `pickUp`: 仅当轮到且无合法牌（防自愿收牌刷补牌）→ 桌面全部入败牌堆 → 摸牌堆空则终局 → 从收牌者起按当前方向补牌至 5 张 → 收牌者任意出牌开新一轮。
- 终局：收牌时摸牌堆空 或 全场手牌空；败牌最少者通杀，并列取座位最小，记为 `lastWinnerId` 供下局先手。
- 托管：轮到自己 30s（掉线 8s）超时自动最小可压牌→A→2→收牌；断线 `connected=false` 展示掉线标记，Socket.IO 重连后 `rejoin` 回原座位，60s 宽限期。

### 同步策略：全量按人定制广播

每次状态变更后 `broadcastState(room)`：对每名玩家 `emit('state', getView(room, pid))`。`getView` 防作弊：只回本人手牌（含 cardId）、他人只给手牌数、摸牌堆只给数量。状态体积极小，全量同步无增量 bug。

### Socket.IO 事件协议

客户端→服务端：`createRoom{nickname}`、`joinRoom{roomCode,nickname}`、`rejoin{roomCode,playerId}`、`leaveRoom`、`ready{ready}`、`start`、`playCard{cardId}`、`pickUp`、`nextRound`。
服务端→客户端：`roomJoined{roomCode,youId,state}`、`state`(全量视图)、`yourTurn{legalMoves,deadline}`、`gameEnd{results,winnerIds,lastWinnerId}`、`error{code,message}`、`roomClosed{reason}`。
错误码：ROOM_NOT_FOUND/ROOM_FULL/NAME_TAKEN/GAME_RUNNING/NOT_YOUR_TURN/ILLEGAL_CARD/MUST_PICK_UP/NOT_READY/NOT_OWNER/BAD_PHASE。

### 前端三视图（public/）

- 房间视图：昵称 → 创建/加入（房间码）；房间面板：大号房间码 + 局域网访问提示、座位列表(昵称/房主👑/准备✓/掉线⚠️)、准备按钮、房主开始按钮(全员 ready 且 3~6 人)。
- 对局视图：顶部信息条(房间码/摸牌堆数/方向↻/局数)；座位环(自己底部、人数自适应、手牌数/败牌数/回合高亮)；中央桌面(门槛牌 + 桌面计数 + 事件日志)；底部手牌区(可出高亮、点击选中+打出按钮、A/2 标注效果)；操作提示条；收牌按钮(仅无合法牌时)。
- 结算覆盖层：败牌排行(少→多，通杀者金色高亮)、「再来一局」、提示通杀者下局先出。

### 局域网部署（server.js）

监听 `0.0.0.0:3000`（PORT 可覆盖）；`os.networkInterfaces()` 打印所有 IPv4 局域网地址；防火墙提示：首次运行勾选专用网络或 `netsh advfirewall firewall add rule name="XiyoujiPoker" dir=in action=allow protocol=TCP localport=3000`；提示手机与电脑需同一 WiFi/网段、关闭 AP 隔离。

## 实施步骤

1. **P0 环境与脚手架**：winget 装 Node LTS → `npm init` + 装 express/socket.io → 建目录与 package.json → Express 托管 public 出 hello 页。
2. **P1 纯逻辑层**：实现 cards.js + engine.js（无 socket 依赖）+ 编写 cards.test.js/engine.test.js → `npm test` 全绿。
3. **P2 网络层**：net.js + server.js：房间注册、全部客户端事件接入、getView/broadcastState/yourTurn/gameEnd/error、掉线托管与 rejoin、局域网 IP 打印。
4. **P3 前端三视图**：index.html + style.css + app.js（房间/对局/结算、错误 toast、重连横幅）。
5. **P4 联调与收尾**：PC 双窗口 + 手机完整跑一局，验收清单见下。

## 验证

- `npm test`：canBeat 覆盖文档 §3.5 速查表全 13 项分支（妖怪逐档/同值/反向/跨组/唐僧/功能隔离/空桌面/牌堆 54 张完整性）；engine 覆盖发牌人数 3~6、A/2 方向、非法操作拒绝、收牌补牌重开、终局结算与并列、先手规则。
- 手动联机：`npm start` → PC 开 2 窗口 + 手机 = 3 人 → 建房加入 → 全员准备开始 → 验证压制/同值不可压(error)/A 跳过/2 反转/收牌补牌重开 → 打满一局验证结算与再来一局先手 → 关窗测掉线托管与重连 → 非法操作均收 error。
