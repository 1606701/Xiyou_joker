# W2 音效调色板 · 西游斗牌（零素材 / Web Audio 合成）

> 版本 v1.0 ｜ 作者：阮和鸣 ｜ 状态：参数可落地，待用户拍板
> 硬约束：无任何音频文件；只用 `OscillatorNode` / `AudioBuffer`(噪声) 合成；移动 Safari 可用；单音 ≤400ms（`settle.win` 例外 600ms）；6 人局多事件并发必须限流。
> 音频方向：**深墨绿夜局 + 暖金**。不 neon、不 8-bit。音色分两族——**人手/牌纸＝sine/triangle（暖）**，**力量/惩罚＝square/sawtooth+噪声（糙）**，靠音色区分"谁在动"，靠音高统一"同一个世界"。

## 1. 统一调式：D 宫五声（D–E–F#–A–B）

全事件音高只允许落在下表 15 个频点（A4=440 十二平均律）。**这是"听起来像同一个游戏"的唯一保证，任何新增音效不得越界。**

| 级 | 宫 | 商 | 角 | 徵 | 羽 |
|---|---|---|---|---|---|
| 低八度 | D2 73.42 | E2 82.41 | F#2 92.50 | A2 110.00 | B2 123.47 |
| 中 | D3 146.83 | E3 164.81 | F#3 185.00 | A3 220.00 | B3 246.94 |
| 高 | D4 293.66 | E4 329.63 | F#4 369.99 | A4 440.00 | B4 493.88 |

**级→语义**（写死，避免各人乱用）：宫 D＝**秩序/回合/提示**；徵 A＝**成立/上扬**；角 F#＝**牌纸动作**；商 E＝**人/入口**；羽 B＝**余韵/终局**。低八度(2 档)＝**惩罚/衰败**，高八度(4 档以上)＝**锐利/警示**。

## 2. 事件 → 音色映射表

音量＝该事件 voiceGain 的**峰值**（0~1，未乘 master）；包络单位秒，S 恒为 0（纯打击型，不设持续段）。

| # | 事件 | 音色意图 | 波形 | 起始→结束频率 (Hz) | A / D / S / R | 时长 | 音量 | 可重叠 |
|---|---|---|---|---|---|---|---|---|
| 1 | `deal` | 牌纸划过桌面，一手 5 张连响要"顺"不要"叮" | noise(带通 Q1.4) + triangle | 噪声中心 1600→1100；音高按张递升 A4 440→B4 494→D5 587→E5 659→F#5 740（>5 张从第 1 档循环） | .002 / .055 / 0 / .035 | 90ms | 0.16 | 是（张间固定 45ms） |
| 2 | `play.single` | 一张牌落在桌面：干、清、短 | triangle | F#4 369.99 固定（尾音微降 -20 音分→365.7） | .004 / .09 / 0 / .06 | 150ms | 0.34 | 否 |
| 3 | `play.combo` | 2~4 张同点一起落：要"厚"不是"响"，低八度垫底 + 8ms 错开 | triangle ×2 | F#4 369.99 固定 + F#3 185.00（低八度，-6dB） | .004 / .12 / 0 / .08 | 190ms | .36/.40/.44（2/3/4 张） | 否 |
| 4 | `beat` | **压住了**：落 + 一个上扬，比 `play` 多"成立感" | triangle | A3 220.00 → D4 293.66 滑音 | .004 / .10 / 0 / .07 | 180ms | 0.46 | 否 |
| 5 | `take` | **全场最疼**：下坠 + 牌堆摩擦长尾（双层）<br>层1 saw 低通 900→380Hz Q1；层2 noise 低通 2200Hz | sawtooth + noise | 220.00 → 82.41（A3→E2，一个八度半下坠） | .006 / .18 / 0 / .12 | 380ms | 0.62 | 是（≥320ms 间隔 → 音量 ×0.6） |
| 6 | `yourTurn` | 轮到你：两音"请"（宫→徵），温和不催促 | sine | D4 293.66 → A4 440.00（两音，间隔 70ms） | .006 / .12 / 0 / .08 | 240ms | 0.42 | 否 |
| 7 | `illegal` | 出牌非法：闷、钝、下行两阶，**绝不刺耳** | square(低通 1200Hz Q0.7) | B3 246.94 → F#3 185.00 | .003 / .07 / 0 / .05 | 140ms | 0.30 | 否 |
| 8 | `settle.win` | 通杀：宫-徵-宫三音上行（唯一 >400ms，600ms 封顶） | triangle | D4 293.66 → A4 440.00 → D5 587.33（间隔 90ms） | .006 / .16 / 0 / .10 | 600ms | 0.55 | 否 |
| 9 | `settle.lose` | 别人通杀：低、钝、下行两音，**不做哭腔** | sine + triangle | B3 246.94 → E3 164.81 | .008 / .22 / 0 / .14 | 380ms | 0.45 | 否 |
| 10 | `join` | 有人进房：木鱼/门铃式单音，亲和 | triangle | E4 329.63 → F#4 369.99 | .004 / .08 / 0 / .06 | 150ms | 0.24 | 否 |
| 11 | `ai` | AI 补位：机械、比"人"低一档，提示**这不是人** | square(低通 900Hz) | F#3 185.00 → E3 164.81 | .002 / .05 / 0 / .04 | 120ms | 0.24 | 否 |
| 12 | `tick` | 最后 3 秒：木质点击，只报时、不抢注意；剩 1 秒升一阶 | noise(带通 900Hz Q6) + square 短脉冲 | D3 146.83 固定；剩 1s 用 F#3 185.00 | .001 / .03 / 0 / .02 | 50ms | 0.22 | 否 |
| 13 | `ui.click` | 按钮：纸牌世界里的轻触 | sine（无滤波，省节点） | A3 220.00 → B3 246.94 | .002 / .03 / 0 / .02 | 60ms | 0.18 | 否 |

**合并说明**：`play.single` 与 `play.combo` 保留两条（厚度差是玩法信息：同点组合是战术，必须可听辨）。`settle.win` / `settle.lose` 不复用 `beat`（结算必须一眼听出"是谁赢"）。
**事件总数：13**（含 1 条合并计入 `take` 的双层）。

## 3. 触发点（工程师必须按此取信号，不要自创）

| 事件 | 信号来源 | 备注 |
|---|---|---|
| `deal` | `state.phase: waiting→playing`，且自己 hand 从 0 变 5 | 一局只响一次（5 连响），**不要**在每条 `state` 广播上重放 |
| `play.*` | 比对前后两帧 `state.tablePile` 的 id 集合，取新增牌 | 必须 diff；重连/刷新时 `roomJoined` 会重放全量 state，无条件播会炸 |
| `beat` | 同一次 play，且该次出牌前桌面已有门槛牌（`topCount>0`） | ⚠️ **依赖缺口**：客户端无 `canBeat`。建议服务端在 state 里加 `lastAction:{by,cards,isBeat}`（一个字段即可彻底消除误判）；否则前端需自带 ~15 行环克判定 |
| `take` | `tablePile` 从 N→0 且 `phase` 未变且未结算 | 同上，建议 `lastAction.type='take'` |
| `yourTurn` | 已有 socket 事件 `yourTurn` ✅ | 事件本身可靠 |
| `illegal` | 服务端 `error` 事件；或本地点了非法牌（`btnPlay` 外的点选） | 只在这两处响，不要在渲染时响 |
| `settle.*` | `gameEnd` 事件 + 判定自己是否 winner ✅ | 结算期 `roomJoined` 也会弹遮罩，那条路径**不补音**（避免刷新重放） |
| `join` / `ai` | diff `state.players` 长度增加；`isAI` 为真走 `ai` | 两者互斥 |
| `tick` | 已有 `yourTurn.deadline`，**但 UI 无倒计时** | ⚠️ **依赖缺口**：需前端加 1Hz 定时器，仅 `deadline-now ≤ 3000` 时每秒一声，第 3/2/1 秒各一次，停在自己行动或超时 |
| `ui.click` | 全局按钮 `click` 委托 | 唯一允许绑定 DOM 层的事件 |

## 4. 并发、去抖、优先级

- **同发声部上限 5 个事件**（一层复合音算 1 声部，但源节点≤3/事件，总源节点≤10）。第 6 个到达不排队，按优先级决定抢占或丢弃。
- **优先级**（大者胜）：`settle.* 100 > take 90 > yourTurn 80 > beat 60 > play.* 55 > illegal 40 > tick 30 > join/ai 25 > deal 20 > ui.click 10`。新到者优先级 ≤ 当前最低在响者 → **直接丢弃**；否则抢占最低者（被抢者 5ms 线性降至 0 再 `stop`）。
- **同事件最小间隔 minGap**（窗口内重复的处理）：

| 事件 | minGap | 重复处理 | 事件 | minGap | 重复处理 |
|---|---|---|---|---|---|
| `deal` | 40ms | 忽略窗口（张间固定 45ms 节奏） | `illegal` | 260ms | 丢弃 |
| `play.single` / `play.combo` | 90ms | 丢弃 | `settle.win` / `settle.lose` | 1500ms | 丢弃 |
| `beat` | 90ms | 丢弃 | `join` / `ai` | 200ms | 丢弃 |
| `take` | 320ms | **允许**，音量 ×0.6（连收牌是真实发生的） | `tick` | 900ms | **必须丢弃**（否则节拍翻倍） |
| `yourTurn` | 400ms | 丢弃（同回合重复＝bug） | `ui.click` | 60ms | 丢弃 |

- **跨事件让路**：`settle.*` 响后 600ms 内丢弃 `play/beat/deal/join/ai`；`take` 响后 200ms 内丢弃 `play/beat`。避免结算音乐被桌面噪点切碎。
- **Headroom**：多声部叠加按 `1/√n` 缩放（n＝当前在响声部数），不要简单相加。链路峰值目标 ≤ **-3 dBFS**，即保留 **6 dB** 余量；`limiter` 只作保险，不作常态压缩。

## 5. 可访问性

- **默认音量**：用户音量 `volume = 0.8`，`masterGain = 0.75 × volume` → 默认有效 0.6（≈ -4.4 dB）。滑块 0~1 映射用感知曲线 `masterGain = 0.75 × v^1.6`。
- **静音持久化**：只存用户显式选择，键 `xyj.audio.muted`（`'1'`/`'0'`，默认 `'0'`）与 `xyj.audio.volume`（默认 `'0.8'`）。静音＝`muteGain → 0`（20ms 斜坡），**不 suspend context**（Safari 上 suspend 后 restore 经常失败）。
- **缺口**：当前 `index.html` 无静音入口。建议 topbar 加 24px 图标按钮（与 `#roomInfo` 同排），点击＝同时切 `ui.click` 音。
- **`prefers-reduced-motion` 结论：不改音量，只减"信息冗余"** —— ①`deal` 5 连响压成 1 声；②`settle.win` 三音琶音压成一个双音（D4+A4）；③`tick` 保留（信息性，砍掉会漏读秒）；④其余不变。理由：reduced-motion 是前庭/晕动诉求，不是听觉诉求，降低音量或全局静音属于过度反应；但高密度短音序列确实会加重不适，所以砍"装饰性密度"、保"信息性单音"。
- iOS 硬件静音开关会直接静音 Web Audio（系统级 ambient 分类），Web 层读不到、也不必对抗 —— **不做"检测系统静音"的伪实现**。

## 6. 实现要点（给工程，非完整代码）

1. **AudioContext 生命周期**：加载时**不创建**。首个 `pointerdown`/`keydown` 里懒建并 `resume()`。此后每次播报前检查 `ctx.state !== 'running'` → 试 `resume()`；**失败就丢弃这一声**，绝不排队补播（补播＝延时噪音）。
2. `visibilitychange` → `hidden` 时停止调度新声；**不 suspend**；`visible` 后再按需 `resume()`。
3. **节点链**：`voiceGain → userGain → muteGain → limiter → destination`。三者分离的原因：音量调节不能覆盖静音状态，限幅必须在最末端。`limiter = DynamicsCompressorNode(threshold -10, knee 8, ratio 6, attack .003, release .15)`。
4. **噪声源用 buffer，不用 oscillator**：初始化时生成 **1 个 0.5s 单声道白噪 buffer**（`ctx.sampleRate` 取值，**不要硬编码 44100**，iOS 常为 48000；≈96KB float32，可接受），每次播放 `new AudioBufferSourceNode` 共享该 buffer。用 oscillator+detune 随机跳变造不出真噪声频谱，还更费 CPU。
5. **包络写法**：起点必须 `0.0001`（`exponentialRampToValueAtTime` 不能到 0），attack 用 `linearRampToValueAtTime` 3~8ms 消咔哒，release 指数降到 `0.0001` 再 `stop`。
   - ❌ 不要用 `setTargetAtTime` 做尾巴：永远逼近不到 0，声部不释放 → 撞并发上限后整局"失声"。
   - ❌ 不要在同一时刻既 `setValueAtTime` 又 `linearRampToValueAtTime`（后者会吞掉起点，产生咔哒）。
   - 需要打断时：`cancelScheduledValues(t)` + 紧接着 `setValueAtTime(当前值, t)`，**别依赖 `cancelAndHoldAtTime`**（旧 Safari 无此方法）。
6. **调度时间**：`t0 = ctx.currentTime + 0.02`，永远不要用 `ctx.currentTime` 当起点（Safari 对已过去的调度点处理不一致，会漏音或立刻爆响）。多音序列（`deal`/`yourTurn`/`settle.win`）一次性用 `t0 + offset` 排完，**不要用 `setTimeout` 排音**（后台标签会被节流成 1000ms）。
7. **滑音**：`frequency.setValueAtTime(f0,t0)` → `exponentialRampToValueAtTime(f1, t0+dur)`；`f1` 不可为 0。
8. **回收**：每源 `stop(t0+dur)` + `onended = () => { try{ node.disconnect() }catch{} }`，同步从活跃声部数组移除；否则并发计数会永久虚高。
9. **性能**：单事件 ≤3 源；`ui.click`/`tick` 之外不建 `BiquadFilter`；不为一次性音效做节点池（oscillator 不可重启，池化无意义）。

## 7. 验收清单（工程师自查）

- [ ] 首次进入页面**全程无声**，第一次点击后才可能出声（iOS 无 console 警告）。
- [ ] 6 人局连续出牌 10 张，听感是"一串有节奏的点"，不是"一团嗡"。
- [ ] `take` 一响就能听出"这是惩罚"；`beat` 与 `play` 能盲听区分；`ai` 与 `join` 能盲听区分。
- [ ] 刷新/重连**不重放**任何音效。
- [ ] 连续点同一按钮 10 次 → 最多 1 声/60ms，无爆音。
- [ ] 静音后刷新页面仍静音；音量值刷新后保留。

## 8. 待用户拍板 / 待协作

1. **调式**：D 宫五声（本方案）vs. A 羽（更阴柔、更"夜"）。倾向前者：金/木质感更足，`settle.win` 的上行更亮。
2. **`take` 的音量 0.62 为全表最高**——是否接受"惩罚音最响"这一听觉权重？若想更克制可降到 0.5。
3. 需工程配合的 3 个缺口：`state.lastAction`（区分 `beat`/`take`）、1Hz 倒计时（`tick`）、静音按钮 UI。
