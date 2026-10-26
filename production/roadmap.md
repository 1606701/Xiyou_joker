# 《西游斗牌》制作路线图

> 版本：v1.0 ｜ 日期：2026-10-26 ｜ 维护：游戏开发工作室主理人（游承峰）
> 评审强度：**lean**（engineering-lead + design-strategist + quality-lead）
> 当前阶段：**Phase 6 打磨入口**，Phase 5 质量门未过

---

## 1. 阶段诊断结论

| 阶段 | 判定 | 依据 |
|---|---|---|
| Phase 1 概念 | PASS | GDD v1.1 含支柱、环形克制、范围分层 |
| Phase 2 系统设计 | PASS | 规则唯一记录处 + Q1–Q8 默认值全部落地 + 版本表 |
| Phase 3 技术搭建 | PASS | `cards` 纯函数 → `engine` 无 I/O → `net` 协议 → `server` 入口，依赖单向 |
| Phase 4 预制作 | **CONCERNS** | 缺 UX 规格、美术资产规格、音频设计；Epic/Story 未拆分 |
| Phase 5 制作 | **CONCERNS** | 核心循环可玩、42 项单测全绿，但 `net/` 层测试覆盖率为 0 |
| Phase 6 打磨 | 进行中 | 缺 QA 计划与性能基线 |
| Phase 7 发布 | BLOCKED | 无发布清单、CHANGELOG、回滚方案 |

**一句话结论**：测试覆盖高的那一层没有 bug，有 bug 的那一层没有测试。

---

## 2. 缺陷清单

### P0 · 阻塞级（已复现）

**缺陷 ID: `BUG-001` — 协议层字段错配导致托管与自动收牌全线失效**

- 位置：`net/net.js:114`
- 现象：`moves.beatIds` / `moves.actionIds` 均不存在，`engine.computeLegalMoves()` 实际返回 `{ opening, beats, actions }`
- 复现：`computeLegalMoves()` 返回键名 `['opening','beats','actions']`；访问 `moves.beatIds.length` 抛 `Cannot read properties of undefined (reading 'length')`
- 后果：
  1. 每次出牌后异常被 socket handler 的 `try/catch` 吞掉，客户端收到一次「操作失败」toast，被误判为误报
  2. 30s 超时托管、无牌 1.5s 自动收牌、掉线 8s 快速托管**从未被调度** → 任何人挂机/锁屏/断网即房间永久卡死
  3. 掉线 60s 宽限期后的房间回收分支实际无效
- 根因：`test/` 仅覆盖 `lib/`，协议层零测试

**缺陷 ID: `BUG-007` — 开轮打出功能牌导致房间永久卡死（v1.0 起既有，GATE-0 挖出）**

- 位置：`lib/engine.js:139`（`computeLegalMoves` 的 `opening` 判定）
- 根因：`opening` 用 `room.tablePile.length === 0` 判断，但 A/2 走功能牌分支不设置 `room.topCard`。开轮打出 A/2 后 `topCard === null` 而 `tablePile.length === 1` → 下家取 `room.topCard.kind` 抛 `Cannot read properties of null (reading 'kind')`
- 后果：下家收不到 `yourTurn`、托管定时器为 0 → 整桌卡死；客户端弹「操作失败」。GDD §6.3 明确允许开轮打功能牌，属合法操作踩中死路
- 修法：`const opening = !room.topCard;`（门槛牌才是压制对象，功能牌本就不改变门槛）
- 状态：W0-ENG-02 修补中

**缺陷 ID: `BUG-008` — 旧连接的 disconnect 误伤已重连玩家**

- 位置：`net/net.js` `handleDisconnect` / `disconnect` / `rejoin`
- 后果：刷新重连后界面冻结、本人被 8s 托管、他人看到假掉线、waiting 阶段 60s 后被踢
- 修法：`handleDisconnect` 加 `player.socketId === socket.id` 归属校验；`clearPlayerTimers` 后移；`rejoin` 作废旧连接

### P1 · 应在下一版修复

| ID | 问题 | 位置 |
|---|---|---|
| BUG-002 | `sendTurn` 的 `isOffline` deadline 分支为死代码（emit 前已按 connected 过滤） | `net/net.js:107-112` |
| BUG-003 | `nextRound` 无房主校验、无防误触，结算页误触会把全房拉回等待 | `net/net.js:302` |
| BUG-004 | `rejoin` 仅凭旧 `socket.id` 即可接管座位，无令牌校验 | `net/net.js:208` |
| BUG-005 | 僵尸房间无 GC：满员且始终 connected 的房间永久驻留内存 | `net/net.js` |
| BUG-006 | 前端 `CARD_NAMES` 与 `lib/cards.js` 双份维护，改牌名必漂移 | `public/app.js:10` |

### P2 · 体验与工程债

- 无 lint / format / CI，`package.json` 缺 `engines` 字段
- `eventLog` 保留 20 条、前端仅显示 3 条，「谁收牌 / 谁反转」一闪而过
- 手机端缺 safe-area 与窄屏适配，6 人局座位存在重叠风险
- 零音效零动效，出牌/收牌/反转全凭文字，节奏感与爽点缺失
- 牌类别仅靠角色标签底色区分（棕/绿/金/紫），色弱不友好
- 无 AI 补位 → 无法单人自测，每次验证需开 3 个浏览器

---

## 3. 三波计划

### Wave 0 · 止血

- **Owner**：`engineering-lead`（实施）+ `quality-lead`（门控）
- **范围**：BUG-001 修复、`net/` 层单测补齐、BUG-002~006 收敛、CI 与 `engines` 字段
- **交付物**：`net/net.js`、`test/net.test.js`、`.github/workflows/ci.yml`、`package.json`
- **门控标准（GATE-0）**：
  - [ ] `npm test` 全绿且用例数 ≥ 57（原 42 + 新增 ≥15）
  - [ ] 挂机 3 分钟不卡局（超时托管生效）
  - [ ] 无牌玩家 1.5s 内自动收牌
  - [ ] 掉线 60s 后房间正确回收
  - [ ] 客户端不再出现「操作失败」误报

### Wave 1 · 稳固

- **Owner**：`design-strategist` + `engineering-lead`（lean 模式下 `art-director` 仅出可访问性清单）
- **范围**：UX 规格（出牌五状态、错误文案表、新手三步引导、结算信息层级）、AI 补位、eventLog 可展开、色弱友好标识
- **门控标准（GATE-1）**：
  - [ ] 单人 + 2 AI 完整跑完 3 局无需人工干预
  - [ ] 设计评审 PASS
  - [ ] 新玩家不询问规则即可完成首局（引导有效）

### Wave 2 · 增味

- **Owner**：`audio-director` + `engineering-lead` + `release-ops-lead`
- **范围**：音效清单与占位音源、发牌/收牌/终局动效、v1.2.0 发布清单与 CHANGELOG、回滚步骤
- **门控标准（GATE-2）**：
  - [ ] 3 / 4 / 6 人各一轮 playtest 完成
  - [ ] QA 签字放行
  - [ ] `启动游戏.cmd` 在干净环境一次跑通

---

## 4. 决策记录

| 日期 | 决策 | 选择 | 理由 |
|---|---|---|---|
| 2026-10-26 | 评审强度 | lean | 个人项目，优先稳定性与可自测，跳过美术/音频正式规格 |
| 2026-10-26 | 首波优先 | Wave 0 止血 | 卡局 bug 不修，后续所有验证都不可靠 |
| 2026-10-26 | 技术形态 | 保持 Web 局域网 | 现有形态已验证，不引入平台迁移风险 |

---

## 5. 门控记录

### GATE-0 · 2026-10-26

| 轮次 | 判定 | 关键发现 |
|---|---|---|
| v1（初评） | **FAIL** | 挖出 BUG-007：开轮打 A/2 导致房间永久卡死（v1.0 起既有）。5 条标准中 2 条无法签字 |
| v2（复议） | **CONCERNS（有条件放行）** | BUG-007 修法获认可（8 条护栏可抓回退）；新增 P2-11 越权写路径；发现 QA 自有 1 条假红线 |
| v3（签收） | **CONCERNS — 待真机签收　｜　Wave 0 可关闭** | P2-11/11b 已修并转硬红线；变异实测 10 红；P2-01/P2-02 保持红作哨兵 |

**标准状态（v3 终态）**

| # | 标准 | 状态 | 证据 |
|---|---|---|---|
| 1 | 测试全绿且 ≥57 条 | ✅ PASS | 97 tests / 95 pass / 0 fail / 2 todo（2 条为已知未修 P2 的红色哨兵，非隐藏失败） |
| 2 | 挂机 3 分钟不卡局 | ⚠️ **待真机签收** | 协议层实测 3 分 10 秒、6 次自动推进、0 error；soak 1000 局 0 死循环；**真机空白** |
| 3 | 无牌 1.5s 自动收牌 | ✅ PASS | 实测 1600ms / 复现 1500ms（v3 未重复测量，diff 未触及 `schedulePickup`） |
| 4 | 掉线 60s 房间回收 | ✅ PASS | 60100ms（口径缺陷见 P2-10：宽限从首个掉线起算，末位掉线者仅 51.09s） |
| 5 | 客户端无误报 | ⚠️ **待真机签收** | 协议层 error 全程 0；**BUG-008 原始症状是界面冻结，属纯 UI 现象，协议测试替代不了** |

**关键数据**：1000 局 soak / 87920 步 / 零违反 / 零死循环 / 2.36s，其中「开轮打功能牌」合法操作出现 **665 次**——即该 P0 在随机对局中本会被踩中 665 次。

**待人工签收**：标准 2 与 5 必须在真实浏览器上走一遍，见 `production/qa/gate-0-report.md` §L 清单。

**本轮新增缺陷**：BUG-007（P0，已修）、BUG-008（P1，已修）、P2-10（宽限起点口径）、P2-11/11b（旧连接越权写，收尾中）、BUG-009（P2 ×10）。

**流程教训**：变异测试必须同时对自己的断言做一次——QA 自身一条「证据」被证明恒真（`dispose()` 内部先 `restore()` 清账本再断言，永远为绿）。

**关账声明（2026-10-26）**：Wave 0 关闭，GATE-0 记为 **CONCERNS — 待真机签收**，不得写 PASS。本声明在三条件下有效：

1. 用户走完 `production/qa/gate-0-report.md` §L 五步真机清单并签字后，GATE-0 方转 PASS。
2. P2-11 / P2-11b 可标 FIXED，但 §U 所列 Wave 1 项**不得标关闭**。
3. **`P2-01`（`dispose` 漏清宽限定时器）与 `P2-02`（幽灵房间守卫）两条 todo 必须保持红色**——将其标绿或删除断言，等同掩盖未修缺陷。

**Wave 0 交付对账**：BUG-001 / BUG-007 / BUG-008 / P2-11 / P2-11b 全部 FIXED；测试 42 → 97；`net/` 层 0 → 31 用例；新增 1000 局随机 soak；变异验证累计 10 组。

**Wave 1 承接清单（按优先级）**

| 优先级 | 项 | 理由 |
|---|---|---|
| 高（≈3 行） | P2-01 `dispose` 漏清 `graceTimer` | 「dispose = 完全释放」契约不成立，留 10 分钟定时器去写已销毁对象 |
| 中 | P2-10 宽限起点 | 末位掉线者仅 51.09s，与「掉线保护 60 秒」对外口径冲突 |
| 中 | `STALE_CONNECTION` 错误码 | 现状是**语义错**：6 条写路径全返回 `ROOM_NOT_FOUND`，前端只读 code 不读 message → 旧页签看到「房间不存在」 |
| 中 | E2E 环境准入 | 标准 2/5 卡在同一处，是全项目最大单点风险 |
| 中 | P2-04 token 不轮换、P2-05 `start` 幂等重排倒计时 | 安全债 + 可被滥用 |
| 低 | P2-02 幽灵守卫、P2-07 重复建房、P2-08 lint、P2-09 凭证残留 | 成本近零 / 需真机验证 |
| 低 | `INTERNAL` 前端文案 | 语义没错但信息量为零，随 Wave 1 文案表一并处理 |
| 不修 | P2-06 GC 基准偏晚 | 只影响精度（最坏 +60s），与标准 4 路径无关，记入已知偏差 |

---

## 6. 变更记录

| 版本 | 日期 | 说明 |
|---|---|---|
| v1.0 | 2026-10-26 | 首次阶段诊断：判定 Phase 6 入口、列出 P0/P1/P2 缺陷、确立三波计划与门控标准 |
| v1.1 | 2026-10-26 | Wave 0 关账：补录 BUG-007（开轮打功能牌卡死）与 BUG-008（旧连接误伤），新增 §5 门控记录（GATE-0 三轮：FAIL → CONCERNS → CONCERNS 待真机签收），确立 Wave 1 承接清单与两条红色哨兵 |
