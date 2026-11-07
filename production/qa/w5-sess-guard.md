# W5 会话凭证守卫化 · QA 记录

> 范围：`public/app.js` 的 `sessionStorage` 访问加固（任务 `W5-ENG-SESS01` / `W5-QA-SESS01` / `W5-E2E-SESS01`）
> 基线：HEAD `dbc4322`（`public/app.js` md5 `62b86a9ca2dab5f478bdf6b23e21ef39`）
> 交付：`public/app.js` md5 `ccfc13cb81e0396b7f295a9aa9c5d0f4` / `test/frontend.test.js` md5 `c060bded27105c9f085e0bb743873ed2`
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

### 3.6 真浏览器全量

`D:/tmp/ui-verify/report.json`：**18 / 18 PASS、0 FAIL、`consoleErrors: []`、`consoleWarnCount: 1`**，含原显示偏好 12 项回归 + 存储禁用进房 + 修前对照。

## 四、方法论记录（踩过的坑）

1. **`node:vm` 的 contextify 不转发 accessor，只转发数据属性。**
   `Object.defineProperty(sandbox,'sessionStorage',{get(){throw}})` 在 vm 内等价于「属性不存在」（`typeof` 返回 `"undefined"`，取值报 `is not defined`）。要模拟「取属性即抛」，必须在 vm 内部 `Object.defineProperty(globalThis,...)`。
   反过来，sandbox 上的**普通对象**（方法内部抛）是会被正常转发的——所以「方法抛」用 `sandbox.sessionStorage = {...}` 有效，「getter 抛」必须用 vm 内部定义。
2. **`opacity` 读数要等过渡结束。**
   `.card` 有 `transition: ... opacity .15s`，`.hand .card.enter` 还有 `animation: dealIn .26s`。在加 `disabled` 类的同一帧读 `getComputedStyle` 会拿到 `0.989931` 这类中间帧。判定前等待 ≥600ms 或 `Promise.all(el.getAnimations().map(a=>a.finished))`。
3. **清理脏 `localStorage` 必须在所有 probe 撤销并 reload 之后做。**
   若在模拟对象仍生效时执行 `removeItem`，它会跟着抛，清理静默失败，前一场景写的 `night` 残留，导致「reload 应回落默认」这类**附带断言**被脏数据坑掉——表面看像产品 bug，其实是装置顺序错了。
4. **跨 vm realm 不要用 `deepStrictEqual` 比较对象**（原型不同会误报）。逐字段 `strictEqual`。
5. **反向变异前先校验目标串命中数。** 命中 0 处等于没变异，会得出「没红所以用例不行」的错误结论。

## 五、未覆盖 / 后续

- 「`typeof` 提到 `try` 外」的变异**不入库**（工程与 QA 一致决定）：它验证的是产品里不存在的错误实现，入库会变成维护绊脚石。结论留本文档 §3.3。
- `[data-theme="light"] .overlay` 的 `alpha .28` 目前只有真浏览器实测，无前端静态断言（不在 W4 规格内，可按需补）。
- `graceTimers.size` 诊断出口 / P2-01 表清理仍无测试覆盖，属长期欠账。
