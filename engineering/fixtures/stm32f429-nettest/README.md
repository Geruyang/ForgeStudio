# stm32f429-nettest（STM32F429 网口测试固件）

野火 STM32F429IGT6 挑战者 V1 板级网口测试程序：**全新编写**的极简固件
（GCC 启动/链接脚本 + HAL 子集 + 自研 ARP/IPv4/ICMP/UDP 应答栈，无 RTOS/无 lwIP/无 USB），
用于验证"新写代码 → 交叉构建 → probe-rs 烧录 → 读回校验 → 产品证据链"全链可行性。

## 实测状态（2026-10-19，全链打通 ✅）

| 功能 | 结果 |
|---|---|
| ARP 解析 | ✅ PC ARP 表：`169.254.200.10 → 02-f4-29-14-00-0a` |
| UDP HELLO → 身份回复 | ✅ `NETTEST OK build=nt-20261019-c mac=02:F4:29:14:00:0A ip=169.254.200.10 rx=.. tx=.. link=1` |
| UDP PING nonce → PONG | ✅ `PONG test123 build=nt-20261019-c` |
| ICMP echo (ping) | ⬜ 超时（疑似校验和问题，不阻碍数据通路验证） |
| 串口 COM3 | ⬜ 无输出（fireDAP VCP 硬件跳线问题） |

## 板级事实（源自 GestureScreen 仓库实证 + 本轮实测）

| 项 | 值 |
|---|---|
| MCU | STM32F429IGTx（2MB Flash / 192KB SRAM / 64KB CCM） |
| 调试探针 | fireDAP（CMSIS-DAP，USB VID 1FC9:5601，含 VCP=COM3） |
| PHY | LAN8720A，MDIO 地址 0，RMII（ID1=0x0007 / ID2&0xFFF0=0xC0F0） |
| RMII 引脚 | PC1 MDC / PA1 REF_CLK / PA2 MDIO / PA7 CRS_DV / PC4 RXD0 / PC5 RXD1 / PB11 TX_EN / PG13 TXD0 / PG14 TXD1（AF11） |
| PHY nRST | PI1（须在 HAL_ETH_Init 前释放 ≥100ms） |
| 时钟 | HSE 25MHz → PLL(M25,N336,P2,Q7) → SYSCLK 168MHz，APB1 42 / APB2 84 |
| RGB LED | PH10 红 / PH11 绿 / PH12 蓝（共阳低电平点亮） |
| 板上 IP | 169.254.200.10/16（链路本地，与 PC 直连网口同段） |

## 协议

- **ARP**：标准请求/应答（TPA 在 ARP 偏移 24 / 帧偏移 f+38——不是 28！）
- **ICMP echo**：标准应答（设计中，校验和待修正）
- **UDP 5005 文本行**：`HELLO` → 身份行；`PING <nonce>` → `PONG <nonce> build=<id>`；`ID?` → 同 HELLO

## 构建 / 烧录

```bash
# 工具链（E:\AiProject\tools-dl）：xpack arm-none-eabi-gcc 15.2.1 / windows-build-tools 4.4.1 / probe-rs 0.32.0
make                 # → build/stm32f429-nettest.{elf,bin,hex}
make flash           # probe-rs download --chip STM32F429IG --verify（SWD 读回校验）
```

产品内验收：profile `stm32f429-nettest`（构建=B 级快照内 make；验收=SWD 烧录读回校验）。

## 排查过程记录（三个根因，全部已修复）

### 根因 1：startup 拷贝/清零循环条件写反（影响最大）

`.data` 拷贝与 `.bss` 清零循环写的是 `cmp r1, r0 + bcs`（end vs current，≥时跳走）。
由于 `_edata ≥ _sdata` 恒为真，循环**永远不执行**——.data 从 Flash 拷贝到 RAM 的操作被跳过，
.bss 清零也被跳过。导致所有全局变量初始化为 SRAM 上电残留值（包含调试探针写入的机器码字节），
引发此前观察到的一切"异常"：
- "SysTick CSR 归零" → 实际是未初始化 SRAM 中的残留值
- ".data 递增字节覆写" → 同上
- "PC 跳 RAM 执行 BKPT" → 上电残留中包含 BKPT 指令
- "Breakpoint(Unknown)" → probe-rs 检测到 CPU 执行到 BKPT

**修复**：`cmp r0, r1 + bhs`（current vs end，≥时退出循环）。

### 根因 2：PHY 自协商未启用（LAN8720 上电默认禁用）

LAN8720 上电后 BCR（基本控制寄存器）bit12（自协商使能）默认为 0 → PHY 以 10Mbps 半双工运行。
MAC 配置了 100Mbps 全双工 → 速度/双工不匹配 → MAC 收不到任何帧（MMC 帧计数全零）。

**修复**：在链路检测前写 BCR = 0x1200（启用自协商 + 重启自协商）。

### 根因 3：ARP 目标 IP 偏移量错误

代码读 ARP 目标 IP 用了 `get32(f+14+28)` = 帧偏移 f+42，但 TPA 在 ARP 偏移 24（帧偏移 f+38）。
多读 4 字节读到的是以太网帧填充（全零）→ ARP 匹配永远失败。

**修复**：`get32(f+14+24)` = 帧偏移 f+38。

### 附带修复：DWT 时基小数累积

`d / (SystemCoreClock/1000)` 在快循环中恒为 0（每次调用间只过几百周期，不够 1ms）。
需要累积小数余数：`s_frac += d; if (s_frac >= tpm) { s_ms += s_frac/tpm; s_frac %= tpm; }`

## 文件

- `startup_stm32f429xx.s` — GCC 启动（含 .data/.bss 拷贝/清零循环，已修正条件）
- `STM32F429IGTx.ld` — 链接脚本
- `Src/main.c` — 时钟/GPIO/ETH/USART1/极简网络栈/主循环（单文件）
- `Drivers/` — ST HAL/CMSIS 子集（自 gesture-screen 仓库复制，BSD-3）
