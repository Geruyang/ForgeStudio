/*
 * stm32f429-nettest：板级网口测试固件（野火 F429 挑战者 V1 + LAN8720，PHY 地址 0）
 * 自写极简 ARP/IPv4/ICMP/UDP 应答栈——验证"新写代码→交叉构建→probe-rs 烧录→PC 实测"全链。
 *
 * 板上网络身份：IP 169.254.200.10/16（链路本地，与 PC 直连网口同段）
 *   ICMP/ARP：标准应答（可 ping）
 *   UDP 5005 文本行协议：
 *     "HELLO"        -> "NETTEST OK build=.. mac=.. ip=.. rx=.. tx=.. link=.."
 *     "PING <nonce>" -> "PONG <nonce> build=<id>"
 *     "ID?"          -> 同 HELLO；其他 -> "ERR unknown-cmd"
 * 串口（USART1 PA9/PA10 115200-8N1）：2s 状态横幅；行协议同上。
 * 时基：DWT CYCCNT（不依赖 SysTick；见 tick.c 的 HAL_GetTick 覆盖）。
 */
#ifndef NETTEST_H
#define NETTEST_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

#define NT_BUILD_ID "nt-20261019-c"

#define NT_MAC0 0x02
#define NT_MAC1 0xF4
#define NT_MAC2 0x29
#define NT_MAC3 0x14
#define NT_MAC4 0x00
#define NT_MAC5 0x0A

#define NT_IP0 169
#define NT_IP1 254
#define NT_IP2 200
#define NT_IP3 10

#define NT_UDP_PORT 5005
#define NT_ETH_PHY_ADDRESS 0U

#define NT_RX_BUF_COUNT 8U
#define NT_TX_BUF_COUNT 4U
#define NT_FRAME_MAX 1536U

typedef struct nt_rx_buf {
  uint32_t used;
  uint16_t len;
  struct nt_rx_buf *next;
  uint8_t data[NT_FRAME_MAX];
} nt_rx_buf_t;

typedef struct {
  uint32_t used;
  uint8_t data[NT_FRAME_MAX];
} nt_tx_buf_t;

/* net.c */
void nt_input(const uint8_t *frame, uint16_t len);
void nt_rx_free_chain(nt_rx_buf_t *head);
int nt_line_reply(const char *line, char *reply, size_t cap);
int nt_fmt_u32(char *out, uint32_t v);
extern volatile uint32_t nt_rx_packets, nt_tx_packets, nt_rx_errors;
extern volatile uint8_t nt_link_up;
extern volatile uint32_t nt_boot_magic, nt_boot_stage, nt_boot_count;

/* tick.c */
void nt_dwt_init(void);

#endif
