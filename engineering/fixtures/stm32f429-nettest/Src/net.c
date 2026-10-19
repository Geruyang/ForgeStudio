/*
 * 极简以太网应答栈（ARP / IPv4 ICMP echo / UDP 身份协议）——无 lwIP。
 * TX 投递形态沿用 GestureScreen gs_ethernet.c 已验证序列
 * （HAL_ETH_Transmit_IT + 固定池 + TxFree 回收）。
 * 字段偏移（帧+14 起）：ARP: 6 OPER/8 SHA/14 SPA/18 THA/28 TPA；
 * IP: 12 源 IP/16 目的 IP/9 协议；UDP(20+): 0 源端口/2 目的端口/4 长度。
 */
#include <string.h>
#include <stddef.h>
#include "nettest.h"
#include "stm32f4xx_hal.h"

extern ETH_HandleTypeDef heth; /* main.c 定义 */

volatile uint32_t nt_rx_packets, nt_tx_packets, nt_rx_errors;
volatile uint8_t nt_link_up;
volatile uint32_t nt_boot_magic, nt_boot_stage, nt_boot_count;

static nt_rx_buf_t s_rx[NT_RX_BUF_COUNT];
static nt_tx_buf_t s_tx[NT_TX_BUF_COUNT];

static const uint8_t s_mac[6] = { NT_MAC0, NT_MAC1, NT_MAC2, NT_MAC3, NT_MAC4, NT_MAC5 };
static const uint8_t s_ip[4] = { NT_IP0, NT_IP1, NT_IP2, NT_IP3 };
static uint8_t s_peer_mac[6];

/* ---- 缓冲池（HAL 回调 ↔ 主循环） ---- */
uint8_t *nt_rx_alloc(void)
{
  for (unsigned i = 0; i < NT_RX_BUF_COUNT; i++) {
    if (s_rx[i].used == 0U) {
      s_rx[i].used = 1U;
      s_rx[i].len = 0U;
      s_rx[i].next = NULL;
      return s_rx[i].data;
    }
  }
  return NULL;
}

void HAL_ETH_RxAllocateCallback(uint8_t **buffer) { *buffer = nt_rx_alloc(); }

void HAL_ETH_RxLinkCallback(void **start, void **end, uint8_t *buffer, uint16_t length)
{
  nt_rx_buf_t *rx = (nt_rx_buf_t *)(buffer - offsetof(nt_rx_buf_t, data));
  nt_rx_buf_t **head = (nt_rx_buf_t **)start;
  nt_rx_buf_t **tail = (nt_rx_buf_t **)end;
  rx->len = length <= NT_FRAME_MAX ? length : 0U;
  rx->next = NULL;
  if (*head == NULL) *head = rx;
  else (*tail)->next = rx;
  *tail = rx;
}

void HAL_ETH_TxFreeCallback(uint32_t *buffer) { ((nt_tx_buf_t *)buffer)->used = 0U; }

void nt_rx_free_chain(nt_rx_buf_t *head)
{
  while (head != NULL) {
    nt_rx_buf_t *n = head->next;
    head->used = 0U;
    head = n;
  }
}

/* ---- 发送 ---- */
static bool nt_send(const uint8_t *frame, uint16_t len)
{
  if (len > NT_FRAME_MAX || !nt_link_up ||
      HAL_ETH_GetState(&heth) != HAL_ETH_STATE_STARTED) return false;
  nt_tx_buf_t *tx = NULL;
  for (unsigned i = 0; i < NT_TX_BUF_COUNT; i++) {
    if (s_tx[i].used == 0U) { s_tx[i].used = 1U; tx = &s_tx[i]; break; }
  }
  if (tx == NULL) return false;
  memcpy(tx->data, frame, len);
  ETH_BufferTypeDef buffer = { 0 };
  buffer.buffer = tx->data;
  buffer.len = len;
  ETH_TxPacketConfigTypeDef packet = { 0 };
  packet.Attributes = ETH_TX_PACKETS_FEATURES_CRCPAD;
  packet.CRCPadCtrl = ETH_CRC_PAD_INSERT;
  packet.Length = len;
  packet.TxBuffer = &buffer;
  packet.pData = tx;
  __DMB();
  if (HAL_ETH_Transmit_IT(&heth, &packet) != HAL_OK) {
    tx->used = 0U;
    return false;
  }
  nt_tx_packets++;
  return true;
}

/* ---- 构造助手 ---- */
static uint16_t checksum16(const uint8_t *p, uint16_t bytes, uint32_t pre)
{
  uint32_t sum = pre;
  for (uint16_t i = 0; i + 1 < bytes; i += 2) sum += ((uint16_t)p[i] << 8) | p[i + 1];
  if (bytes & 1U) sum += (uint16_t)p[bytes - 1] << 8;
  while (sum >> 16) sum = (sum & 0xFFFFU) + (sum >> 16);
  return (uint16_t)(~sum & 0xFFFFU);
}
static void put16(uint8_t *p, uint16_t v) { p[0] = v >> 8; p[1] = v; }
static void put32(uint8_t *p, uint32_t v) { p[0] = v >> 24; p[1] = v >> 16; p[2] = v >> 8; p[3] = v; }
static uint16_t get16(const uint8_t *p) { return (uint16_t)((p[0] << 8) | p[1]); }
static uint32_t get32(const uint8_t *p)
{
  return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}
static uint8_t *eth_head(uint8_t *out, const uint8_t *dst, uint16_t etherType)
{
  memcpy(out, dst, 6);
  memcpy(out + 6, s_mac, 6);
  put16(out + 12, etherType);
  return out + 14;
}

static void send_arp_reply(const uint8_t *in, uint16_t len)
{
  if (len < 14 + 28) return;
  uint8_t out[42];
  uint8_t *p = eth_head(out, in + 6, 0x0806);
  put16(p + 0, 1);        /* HTYPE Ethernet */
  put16(p + 2, 0x0800);   /* PTYPE IPv4 */
  p[4] = 6; p[5] = 4;
  put16(p + 6, 2);        /* OPER reply */
  memcpy(p + 8, s_mac, 6);        /* SHA */
  put32(p + 14, get32(s_ip));     /* SPA = 本板 */
  memcpy(p + 18, in + 6, 6);      /* THA = 请求方 */
  put32(p + 24, get32(in + 28));  /* TPA = 请求方 IP */
  (void)nt_send(out, 42);
}

static void send_icmp_echo_reply(const uint8_t *in, uint16_t iplen)
{
  if (iplen < 20 + 8) return;
  uint16_t payLen = iplen - 20;
  if (payLen > 236) payLen = 236;
  const uint8_t *req = in + 20;
  uint8_t buf[14 + 20 + 236];
  uint8_t *ip = eth_head(buf, s_peer_mac, 0x0800);
  memset(ip, 0, 20);
  ip[0] = 0x45;
  put16(ip + 2, 20 + payLen);
  ip[6] = 0x40;
  ip[8] = 64;
  ip[9] = 1;
  memcpy(ip + 12, in + 16, 4);
  memcpy(ip + 16, in + 12, 4);
  put16(ip + 10, checksum16(ip, 20, 0));
  uint8_t *icmp = ip + 20;
  memcpy(icmp, req, payLen);
  icmp[0] = 0; icmp[1] = 0; icmp[2] = 0; icmp[3] = 0;
  put16(icmp + 2, checksum16(icmp, payLen, 0));
  (void)nt_send(buf, 14 + 20 + payLen);
}

static void send_udp_reply(const uint8_t *in, uint16_t iplen, const char *reply, uint16_t replyLen)
{
  if (iplen < 20 + 8) return;
  uint8_t buf[14 + 20 + 8 + 160];
  uint8_t *ip = eth_head(buf, s_peer_mac, 0x0800);
  memset(ip, 0, 20);
  ip[0] = 0x45;
  put16(ip + 2, 20 + 8 + replyLen);
  ip[6] = 0x40;
  ip[8] = 64;
  ip[9] = 17;
  memcpy(ip + 12, in + 16, 4);
  memcpy(ip + 16, in + 12, 4);
  put16(ip + 10, checksum16(ip, 20, 0));
  uint8_t *udp = ip + 20;
  put16(udp + 0, get16(in + 20 + 2)); /* 源端口 = 请求目的端口 */
  put16(udp + 2, get16(in + 20 + 0)); /* 目的端口 = 请求源端口 */
  put16(udp + 4, 8 + replyLen);
  put16(udp + 6, 0);
  memcpy(udp + 8, reply, replyLen);
  (void)nt_send(buf, 14 + 20 + 8 + replyLen);
}

/* 身份应答（手写格式化，无 snprintf/printf 依赖） */
static int append_str(char **o, size_t *left, const char *s)
{
  size_t n = strlen(s);
  if (n >= *left) return 0;
  memcpy(*o, s, n);
  *o += n;
  *left -= n;
  return 1;
}
static int append_u32(char **o, size_t *left, uint32_t v)
{
  char t[11];
  nt_fmt_u32(t, v);
  return append_str(o, left, t);
}

static int build_reply(const char *req, char *reply, size_t cap)
{
  char *o = reply;
  size_t left = cap;
  if (strncmp(req, "HELLO", 5) == 0 || strcmp(req, "ID?") == 0) {
    if (!append_str(&o, &left, "NETTEST OK build=")) return 0;
    if (!append_str(&o, &left, NT_BUILD_ID)) return 0;
    if (!append_str(&o, &left, " mac=02:F4:29:14:00:0A ip=169.254.200.10 rx=")) return 0;
    if (!append_u32(&o, &left, nt_rx_packets)) return 0;
    if (!append_str(&o, &left, " tx=")) return 0;
    if (!append_u32(&o, &left, nt_tx_packets)) return 0;
    if (!append_str(&o, &left, " link=")) return 0;
    if (!append_str(&o, &left, nt_link_up ? "1" : "0")) return 0;
    return (int)(o - reply);
  }
  if (strncmp(req, "PING ", 5) == 0) {
    const char *nonce = req + 5;
    size_t n = strlen(nonce);
    if (n == 0 || (size_t)(5 + n + 7 + strlen(NT_BUILD_ID)) >= cap) return 0;
    memcpy(reply, "PONG ", 5);
    memcpy(reply + 5, nonce, n);
    memcpy(reply + 5 + n, " build=", 7);
    memcpy(reply + 5 + n + 7, NT_BUILD_ID, strlen(NT_BUILD_ID));
    return (int)(5 + n + 7 + strlen(NT_BUILD_ID));
  }
  {
    const char *e = "ERR unknown-cmd";
    size_t n = strlen(e);
    if (n >= cap) return 0;
    memcpy(reply, e, n);
    return (int)n;
  }
}

int nt_line_reply(const char *line, char *reply, size_t cap)
{
  return build_reply(line, reply, cap);
}

int nt_fmt_u32(char *out, uint32_t v)
{
  char t[10];
  int i = 0, j = 0;
  if (v == 0) { out[0] = '0'; out[1] = '\0'; return 1; }
  while (v) { t[i++] = (char)('0' + (v % 10)); v /= 10; }
  while (i) out[j++] = t[--i];
  out[j] = '\0';
  return j;
}

void nt_input(const uint8_t *frame, uint16_t len)
{
  if (len < 14) { nt_rx_errors++; return; }
  uint16_t etype = get16(frame + 12);
  bool toMe = memcmp(frame, s_mac, 6) == 0;
  bool bcast = memcmp(frame, "\xFF\xFF\xFF\xFF\xFF\xFF", 6) == 0;

  if (etype == 0x0806) { /* ARP：仅应答 TPA（帧 +14+28）为本板的请求 */
    if (len < 14 + 28 || get16(frame + 14 + 6) != 1) return;
    if ((toMe || bcast) && get32(frame + 14 + 28) == get32(s_ip)) {
      memcpy(s_peer_mac, frame + 6, 6);
      send_arp_reply(frame, len);
      nt_rx_packets++;
    }
    return;
  }
  if (etype != 0x0800) return;
  const uint8_t *ip = frame + 14;
  uint16_t iplen = len - 14;
  if (iplen < 20 || (ip[0] >> 4) != 4) { nt_rx_errors++; return; }
  uint16_t total = get16(ip + 2);
  if (total > iplen) { nt_rx_errors++; return; }
  if (checksum16(ip, 20, 0) != 0) { nt_rx_errors++; return; }
  uint32_t dstIp = get32(ip + 16);
  if (dstIp != get32(s_ip) && dstIp != 0xFFFFFFFFU) return;
  memcpy(s_peer_mac, frame + 6, 6);
  nt_rx_packets++;

  uint8_t proto = ip[9];
  if (proto == 1) { /* ICMP echo */
    if (iplen >= 20 + 8 && ip[20] == 8) send_icmp_echo_reply(ip, total);
    return;
  }
  if (proto == 17 && total >= 20 + 8) { /* UDP 身份协议 */
    uint16_t dport = get16(ip + 20 + 2);
    if (dport != NT_UDP_PORT) return;
    uint16_t udpLen = get16(ip + 20 + 4);
    if (udpLen < 8 || 20 + udpLen > total) return;
    const char *payload = (const char *)(ip + 20 + 8);
    uint16_t payLen = udpLen - 8;
    char reply[160];
    char req[64];
    uint16_t n = payLen < sizeof(req) - 1 ? payLen : sizeof(req) - 1;
    for (uint16_t i = 0; i < n; i++) req[i] = (payload[i] == '\r' || payload[i] == '\n') ? ' ' : payload[i];
    req[n] = '\0';
    while (n > 0 && req[n - 1] == ' ') req[--n] = '\0';
    int rl = build_reply(req, reply, sizeof(reply));
    if (rl > 0) send_udp_reply(ip, total, reply, (uint16_t)rl);
  }
}
