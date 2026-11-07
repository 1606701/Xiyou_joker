# W5 会话凭证守卫化 · QA 记录

> 范围：`public/app.js` 的 `sessionStorage` 访问加固（任务 `W5-ENG-SESS01` / `W5-QA-SESS01` / `W5-E2E-SESS01`）
> 基线：HEAD `dbc4322`（`public/app.js` md5 `62b86a9ca2dab5f478bdf6b23e21ef39`）
> 交付：`public/app.js` md5 `ccfc13cb81e0396b7f295a9aa9c5d0f4` / `test/frontend.test.js` md5 `f6561d8b02fbf59d719fda213908b31c`
> 判定：**PASS**

## 一、为什么修

`public/app.js` 原有 10 处裸调 `sessionStorage`：

| 位置 | 调用 | 所在回调 |
|---|---|---|
| `:116~118` | `getItem` ×3（roomCode / playerId / rejoinToken） | `socket.on('connect')` |
| `:129~131` | `setItem` ×3 | `socket.on('roomJoined')` |
| `:245` | `clear()` | `socket.on('roomClosed')` |
| `:254~256` | `removeItem` ×3 | `resetToHome()` |

站点存储被整体禁用时（浏览器禁用站点数据、部分无痕策略、iframe 第三方上下文），**访问 `sessionStorage` 这个属性本身**就抛 `SecurityError`。危害不是「丢凭证」，而是**异常抛在处理器中间会截断后续逻辑**：

- `roomJoined` 里 `setItem` 抛 → `S.state = state`、`showView()`、`renderRoom()` 全不执行 → **用户进了房间却停在首页**；
- `roomClosed` 里 `clear()` 抛 → 不弹「房间已解散」、不回首页；
- `resetToHome` 里 `removeItem` 抛 → 退不出房间。

## 二、改法

新增 4 个 helper（`public/app.js:62~102`），内部全包 `try/catch`：

- `sessGet(key)` —— 不可用时返回 `null`（退化为「刷新后不回座」）
- `sessSet(key, value)` —— 失败返回 `false`，仅首次 `console.warn`（`sessWarned` 模块级标志），**调用方不得据此分支**
- `sessRemove(key)` / `sessClear()` —— 失败静默

**关键实现点：`typeof sessionStorage` 检查必须放在 `try` 内部。** 对已声明且 getter 抛异常的属性，`typeof` 会传播异常；只有未声明标识符才特殊返回 `"undefined"`。把检查提到 `try` 外等于把缺陷原样装回去。

## 三、证据链

### 3.1 静态测试：修前必红

用 `git show HEAD:public/app.js` 取真实修前快照（md5 `62b86a9c…`，10 处裸调、0 helper），通过 `FE_APP` 指向副本：

```
# tests 50 / # pass 47 / # fail 3
not ok 47 roomJoined setItem 抛 → Actual message: "blocked"；栈 app-head.js:129
not ok 48 roomClosed clear 抛   → Actual message: "blocked"；栈 app-head.js:245
not ok 49 resetToHome removeItem 抛 → Actual message: "blocked"；栈 app-head.js:254
```

失败栈精确落在被测代码的裸调行，不是用例自身报错。

### 3.2 反向变异：每条用例钉住对应那一行

从**修复后**代码出发，逐行改回裸调用（变异前先校验目标串命中数必须为 1，否则 abort）：

| 变异 | 结果 | 红的用例 |
|---|---|---|
| 空白对照（原样副本） | 50 pass / 0 fail | 无 |
| `sessSet('roomCode')` → 裸 `setItem` | 49 / 1 | 仅 #47 场景 42 |
| `sessClear()` → 裸 `clear()` | 49 / 1 | 仅 #48 场景 43 |
| `sessRemove('roomCode')` → 裸 `removeItem` | 49 / 1 | 仅 #49 场景 44 |

**这组变异证明用例钉的是「对应那一行」，而不是「HEAD 版本整体有毛病所以红」。**

### 3.3 `typeof` 位置：场景 46 独有护栏

把 4 个 helper 的 `typeof sessionStorage` 全部提到 `try` 外（命中 4/4 处）：

```
# tests 51 / # pass 50 / # fail 1
not ok 51 sessionStorage 属性 getter 抛（真实禁用模式）时三条路径都不得截断
```

**只有场景 46 红，42~45 免疫** —— 因为 42~45 是「方法抛」，属性访问本身成功，`typeof` 放哪儿都返回 `'object'`。这证明场景 46 不是 42~45 的重复品，它守的是另一条代码路径。

### 3.4 前端用例覆盖矩阵

| 用例 | 禁用模式 | 覆盖路径 |
|---|---|---|
| 场景 42 | 方法抛（`setItem`） | `roomJoined` 不截断视图切换 |
| 场景 43 | 方法抛（`clear`） | `roomClosed` 仍弹提示并回首页 |
| 场景 44 | 方法抛（`removeItem`） | `resetToHome` 仍切回首页 |
| 场景 45 | 存储正常 | 三凭证写入 / 刷新后 rejoin / 缺 token 发空串 |
| 场景 46 | **属性 getter 抛** | 上述三条路径全覆盖 |

场景 42 额外钉住「连写 3 个 key 只 warn 一次」；场景 44 有前置动作（先把 `#view-home` 设 hidden、`#view-room` 设可见），否则假 DOM 中所有 view 初始无 class，「切回首页」会天然成立——典型假绿。

### 3.5 真浏览器：修前/修后对照（最强证据）

CDP 注入 `Object.defineProperty(window,'sessionStorage',{get(){throw new DOMException('blocked','SecurityError')}})`，走真实「填昵称 → 创建房间」流程：

| | 修前（HEAD 版，`typeof window.sessGet === 'undefined'` 自证） | 修后 |
|---|---|---|
| `#view-room` | `hiddenClass=true` `display=none` | `hiddenClass=false` `display=flex` |
| `#view-home` | `display=flex`（**停在首页**） | `hiddenClass=true` `display=none` |
| `#roomCodeBig` | `""` | `"414"` |
| 捕获异常 | **2 × `SecurityError: blocked`** | **0** |

注入自证三点（缺一结论不成立）：
1. `window.sessionStorage` 取属性 → `SecurityError`；`typeof window.sessionStorage` → **也抛** `SecurityError`（证明是真 getter 抛，而非属性不存在）
2. `typeof localStorage === 'object'`、`getItem` 正常 → 未连带打掉 localStorage
3. 注入后首屏 `data-theme=light` → 显示偏好未受影响

`console.warn` 恰好 1 条 `[西游斗牌] 会话存储不可用，刷新后将无法自动回座（不影响当前对局）： SecurityError`，与「只 warn 一次」设计一致。

截图：`session-storage-disabled-room-BEFORE.png` / `session-storage-disabled-room.png`

### 3.5b 真浏览器：离开房间路径

`resetToHome()` 里 `removeItem` 抛会跳过 `showView('view-home')`，实际表现是「退不出房间」。注入 sessionStorage 取属性即抛 → 填昵称 → 创建房间 → 点 `#btnLeave`：

- `#view-room` `hidden=true` `display=none`
- `#view-home` `hidden=false` `display=flex`
- 本项 exception = **0**

截图：`session-storage-disabled-leave-room.png`

**诚实边界**：修前版本在 `sessionStorage` 抛时**连房间都进不去**（`roomJoined` 的 `setItem` 先中断），所以 `resetToHome` 的缺陷在修前版本被前置断点遮蔽，**真机无法独立复现**，它只是代码层面的理论隐患。该路径的真机验证只在修后版本成立；修前行为由单测场景 44 覆盖（`FE_APP` 指 HEAD 版时该条红）。

### 3.6 真浏览器全量

`D:/tmp/ui-verify/report.json`：**19 / 19 PASS、0 FAIL、`consoleErrors: []`、`consoleWarnCount: 2`**，含原显示偏好 12 项回归 + 存储禁用「进房 + 离开房间」两条真实路径 + 修前对照。

两条 `console.warn` **文本完全相同**，均为 `public/app.js` 的会话存储降级提示（实测 `report.consoleWarns` 两条一字不差，已排除 `app.js` 的视图不一致告警与牌面拉取失败告警）。它们分属场景 B 与场景 E 两个页面：每次页面加载 `sessWarned` 都会重置，各自在「创建房间」时 `sessSet` 失败告警一次。**场景 E 的退房走 `sessRemove`，其 catch 不告警——第二条来自该页面进房时刻，不是退房时刻。** 两者均不计入 error 判定。

## 四、方法论记录（踩过的坑）

1. **`node:vm` 的 contextify 不转发 accessor，只转发数据属性。**
   `Object.defineProperty(sandbox,'sessionStorage',{get(){throw}})` 在 vm 内等价于「属性不存在」（`typeof` 返回 `"undefined"`，取值报 `is not defined`）。要模拟「取属性即抛」，必须在 vm 内部 `Object.defineProperty(globalThis,...)`。
   反过来，sandbox 上的**普通对象**（方法内部抛）是会被正常转发的——所以「方法抛」用 `sandbox.sessionStorage = {...}` 有效，「getter 抛」必须用 vm 内部定义。
2. **`opacity` 读数要等入场动画结束。**
   `.hand .card` 的 transition 是 `transform .16s, box-shadow .16s, border-color .16s`（`public/style.css:728~731`）——**不含 opacity**。带 `opacity .15s` 的是 `:178` 的 **`.btn`**，与手牌无关，别把两者混为一谈（本条曾误写成 `.card` 有 opacity transition，已更正）。
   真正来源是 `:749` 的 `.hand .card.enter { animation: dealIn .26s cubic-bezier(.22,.61,.36,1) backwards }` 与 `:1035~1038` 的 `@keyframes dealIn { from { opacity:0 } to { opacity:1 } }`：**动画运行期内，animation 来源的 opacity 优先级高于 `.disabled{opacity:.72}` 这条普通声明**，所以动画跑完之前 `.disabled` 的值根本不可见。
   实测（4 张牌、与 class 切换同帧读取）：`0.964638 / 0.926383 / 0.866008 / 0.773617` —— 四张各不相同，正说明它们处在动画的不同进度；同帧 `getAnimations()` 四张全是 `state:"running", name:"dealIn"`。用 `MutationObserver` 在 class 变更同一刻由浏览器自采样，`t=0` 时 `op="0"`、`cls="card has-art disabled enter"`。
   等 `Promise.all(anims.finished)` + `sleep(600)` 后：四张全部 `0.72`（±0.01）。
   `fill` 是 `backwards` 而不是 `both`：动画一结束动画值即被丢弃，`.disabled{.72}` 直接接管，所以运行时读数是精确的 `"0.72"` 而非 `0.7199`。也正因为 `.card` 没有 opacity 的 transition，这个接管是**瞬跳**而非渐变——观感上是「牌落定的那一刻淡下去」。
   这个 1 帧硬切是**有意保留的取舍**：改 `fill-mode` 会让 opacity 锁死在 keyframe 的 `to` 值 `1.0`（手牌完全不淡，`.disabled{.72}` 与场景 38b 的交叉验证随之失效）；正解是让 `dealIn` 的 `to` 走 CSS 变量、或给 `.disabled` 单独写 keyframes，代价与收益（仅 1 帧）不成比例，故本波不动，仅留档。
   **`fill-mode` 是跨层耦合的前提**：场景 38b 的静态断言读的是 authored `.72`，它与运行时读数能否逐字符对上取决于 `backwards`。若有人改成 `both`，`npm test` 仍会全绿（静态断言不读运行时），但 38b 与真机读数之间的交叉验证就静默失效了——所以 38b 里加了注释把这条耦合显性化。
   结论：这不是「样式没生效」，是 CSS 层叠的正常行为 —— 任何早于动画结束的读数都落在 0↔1 之间，判定必须等动画结束。
   **注意区分两层，别把这条纪律套到静态断言上**：动画中间帧只影响运行时的 `getComputedStyle` 读数；前端静态断言（场景 38b）读的是 `public/style.css` 的**源码文本**，用正则提取 `.hand .card.disabled` 的声明值，不经过渲染，不存在中间帧，也不需要等待任何东西。`dbc4322` 删除的是与场景 38b **重复的等价断言**（同一 CSS 声明挂两道闸门），与 `dealIn` 动画无关。
3. **清理脏 `localStorage` 必须在所有 probe 撤销并 reload 之后做。**
   若在模拟对象仍生效时执行 `removeItem`，它会跟着抛，清理静默失败，前一场景写的 `night` 残留，导致「reload 应回落默认」这类**附带断言**被脏数据坑掉——表面看像产品 bug，其实是装置顺序错了。
   实测取证：B 场景 `清理前={"xyj.fs":"99","xyj.theme":"night"} → 清理后={} | 清理语句是否抛=否`。修好顺序后 B/C 的 `reload` 均读到 `light/1`。
4. **跨 vm realm 不要用 `deepStrictEqual` 比较对象**（原型不同会误报）。逐字段 `strictEqual`。
5. **反向变异前先校验目标串命中数。** 命中 0 处等于没变异，会得出「没红所以用例不行」的错误结论。
6. **截图要标清「模拟态」还是「真实态」。**
   `not-my-turn.png` / `not-my-turn-v2.png` 是第 5 项的 **DOM 模拟态**（提示条被切成「等待 悟净·AI 出牌…」，但 `handMeta` 仍是真实态的「轮到你」），两者不自洽是模拟造成的，**不是产品文案矛盾**。真实态看 `not-my-turn-real-v2.png`：提示「等待 悟能 出牌…」+ handMeta「手牌 4 张」，自洽。看图的人很容易被这组图误导，报告里必须写明。

## 五、未覆盖 / 后续

- `roomClosed` 的 `clear()` 路径**未做真机验证**：该路径仅由单测场景 43 覆盖。决定不补的理由是 `sessClear` 与 `sessRemove` 同构（同样是 `typeof` 守卫 + `try/catch`），而真正的风险路径 `resetToHome → showView('view-home')` 已真机验证；触发房间解散需双端协作，成本高、边际覆盖低。若日后要做全路径真机矩阵，需补一个双客户端场景。
- 「`typeof` 提到 `try` 外」的变异**不入库**（工程与 QA 一致决定）：它验证的是产品里不存在的错误实现，入库会变成维护绊脚石。结论留本文档 §3.3。
- `[data-theme="light"] .overlay` 的 `alpha .28` 目前只有真浏览器实测，无前端静态断言（不在 W4 规格内，可按需补）。
- `graceTimers.size` 诊断出口 / P2-01 表清理仍无测试覆盖，属长期欠账。
