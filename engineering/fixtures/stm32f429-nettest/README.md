# stm32f429-nettest（STM32F429 网口测试固件）

野火 STM32F429IGT6 挑战者 V1 板级网口测试程序：**全新编写**的极简固件
（GCC 启动/链接脚本 + HAL 子集 + 自研 ARP/IPv4/ICMP/UDP 应答栈，无 RTOS/无 lwIP/无 USB），
用于验证"新写代码 → 交叉构建 → probe-rs 烧录 → 读回校验 → 产品证据链"全链可行性。

## 板级事实（源自 GestureScreen 仓库实证 + 本轮实测）

| 项 | 值 |
|---|---|
| MCU | STM32F429IGTx（2MB Flash / 192KB SRAM / 64KB CCM） |
| 调试探针 | fireDAP（CMSIS-DAP，USB VID 1FC9:5601，含 VCP=COM3） |
| PHY | LAN8720A，MDIO 地址 0，RMII（ID1=0x0007 / ID2&0xFFF0=0xC0F0） |
| RMII 引脚 | PC1 MDC / PA1 REF_CLK / PA2 MDIO / PA7 CRS_DV / PC4 RXD0 / PC5 RXD1 / PB11 TX_EN / PG13 TXD0 / PG14 TXD1（AF11） |
| PHY nRST | PI1（须在 HAL_ETH_Init 前释放） |
| 时钟 | HSE 25MHz → PLL(M25,N336,P2,Q7) → SYSCLK 168MHz，APB1 42 / APB2 84 |
| RGB LED | PH10 红 / PH11 绿 / PH12 蓝（共阳低电平点亮） |
| 调试串口 | USART1 PA9/PA10 115200-8N1（本轮 COM3 未见面输出——VCP 接线待确认） |
| 板上 IP | 169.254.200.10/16（链路本地，与 PC 直连网口同段） |

## 协议

- ICMP echo / ARP：标准应答（设计目标：可 ping）
- UDP 5005 文本行：`HELLO` → 身份行（build/mac/ip/rx/tx/link）；
  `PING <nonce>` → `PONG <nonce> build=<id>`；串口行协议同。

## 构建 / 烧录

```bash
# 工具链（E:\AiProject\tools-dl）：xpack arm-none-eabi-gcc 15.2.1 / windows-build-tools 4.4.1 / probe-rs 0.32.0
make                 # → build/stm32f429-nettest.{elf,bin,hex}
make flash           # probe-rs download --chip STM32F429IG --verify（SWD 读回校验）
```

产品内验收：profile `stm32f429-nettest`（构建=B 级快照内 make；验收=SWD 烧录读回校验）。

## 实测状态（2026-10-19，如实记录）

**已验证 ✅**
- GCC 全新构建（启动文件/链接脚本/时钟/GPIO 自写 + HAL 子集）：text ~11KB，零告警
- probe-rs 经 fireDAP 烧录 + **读回校验**（--verify 比对 flash 与 ELF）多次成功
- 板上启动：boot magic/stage 推进至主循环（DWT 时基方案，见下）
- **MDIO 通信成功**：PHY ID 读取匹配 LAN8720、链路状态寄存器可读、自协商完成
- **产品级闭环**（`FD_STM32_LIVE=1 npx vitest run test/stm32-nettest.live.test.ts`）：
  任务 → B 级快照内构建（elf sha256 2344d123…）→ SWD 烧录读回校验（0.85s）→
  验收点亮 → 证据落库——**"新写代码可行性"核心闭环成立**

**未解决 ❌（板级 ETH 数据通路）**
- ARP 请求不应答（PC ping 169.254.200.10 不可达）；RAM 观测到来源不明的递增字节流写入
  （自写栈与 lwIP 移植两种方案同样表现 → 排除上层代码架构原因）
- 排查记录：MACCR/DMA 寄存器配置正确（100M 全双工、DMAIER 含 RIE、DMARDLAR 指向描述符表）；
  描述符 OWN 置位但 buffer 指针出现异常值；SYSCFG RMII 选择由 HAL_Init 自理（已排除）；
  SysTick 异常归零现象 → 已用 DWT CYCCNT 时基绕开（HAL_GetTick 覆盖，tick.c）
- 下一步建议：①示波器看 PA1 REF_CLK 50MHz 质量；②对比 GestureScreen 固件（需开
  GS_ENABLE_ETHERNET 重编译，其发布版默认关闭以太网）在同板抓包；③检查 PHY nRST 电路
  与 25MHz 晶振起振；④尝试 MII 模式交叉验证

## 文件

- `startup_stm32f429xx.s` / `STM32F429IGTx.ld` — GCC 启动与链接（自写）
- `Src/main.c` — 时钟/GPIO/ETH 初始化/USART1 直驱/主循环
- `Src/net.c` — ARP/ICMP/UDP 极简应答栈（手写校验和与格式化，无 libc printf 依赖）
- `Src/tick.c` — DWT CYCCNT 时基（HAL_GetTick 覆盖）
- `Drivers/` — ST HAL/CMSIS 子集（自 gesture-screen 仓库复制，BSD-3）
