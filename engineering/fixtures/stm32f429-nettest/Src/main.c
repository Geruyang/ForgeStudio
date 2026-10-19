/*
 * stm32f429-nettest 主程序（野火挑战者 V1）— startup .data/.bss 修复版
 * 根因：startup 拷贝/清零循环条件写反（cmp r1,r0+bcs = end≥current 恒真→循环不执行），
 * 导致 .data 未拷贝、.bss 未清零——RAM 全是未初始化 SRAM 残留（含调试探针写入的机器码字节），
 * 引发此前观察到的一切"异常"（SysTick CSR 归零、.data 递增覆写、PC 跳 RAM、BKPT）。
 */
#include <string.h>
#include <stddef.h>
#include "stm32f4xx_hal.h"
#include "nettest.h"
#include "usb_device.h"
#include "usbd_cdc_if.h"

ETH_HandleTypeDef heth;
ETH_DMADescTypeDef DMARxDscrTab[ETH_RX_DESC_CNT];
ETH_DMADescTypeDef DMATxDscrTab[ETH_TX_DESC_CNT];

volatile uint32_t nt_rx_packets, nt_tx_packets, nt_rx_errors;
volatile uint8_t nt_link_up;
volatile uint32_t nt_boot_magic, nt_boot_stage, nt_boot_count;
/* PHY 诊断（主循环周期更新） */
volatile uint32_t nt_phy_bcr, nt_phy_bsr, nt_phy_scsr;
volatile uint32_t nt_tx_fail_pool, nt_tx_fail_hal, nt_tx_ok, nt_arp_seen;
volatile uint32_t nt_et_arp, nt_et_ipv4, nt_et_other, nt_bc_count;
volatile uint32_t nt_last_etype, nt_last_len;
volatile uint8_t nt_last_frame[64];
volatile uint32_t nt_arp_target_ip, nt_arp_our_ip;
volatile uint32_t nt_icmp_seen, nt_icmp_tx;

#define LED_R_PORT GPIOH
#define LED_R_PIN  GPIO_PIN_10
#define LED_G_PORT GPIOH
#define LED_G_PIN  GPIO_PIN_11
#define LED_B_PORT GPIOH
#define LED_B_PIN  GPIO_PIN_12
#define PHY_RST_PORT GPIOI
#define PHY_RST_PIN  GPIO_PIN_1

#define NT_PHY_BSR 1U
#define NT_PHY_ID1 2U
#define NT_PHY_ID2 3U
#define NT_PHY_SCSR 31U
#define NT_PHY_LINK_BIT 0x0004U
#define NT_PHY_AN_DONE_BIT 0x0020U

void Error_Handler(void)
{
  __disable_irq();
  for (;;) { HAL_GPIO_TogglePin(LED_R_PORT, LED_R_PIN); for (volatile int i = 0; i < 4000000; i++) __NOP(); }
}

static void SystemClock_Config(void)
{
  RCC_OscInitTypeDef osc = { 0 };
  RCC_ClkInitTypeDef clk = { 0 };
  __HAL_RCC_PWR_CLK_ENABLE();
  __HAL_PWR_VOLTAGESCALING_CONFIG(PWR_REGULATOR_VOLTAGE_SCALE1);
  osc.OscillatorType = RCC_OSCILLATORTYPE_HSE;
  osc.HSEState = RCC_HSE_ON;
  osc.PLL.PLLState = RCC_PLL_ON;
  osc.PLL.PLLSource = RCC_PLLSOURCE_HSE;
  osc.PLL.PLLM = 25; osc.PLL.PLLN = 336; osc.PLL.PLLP = RCC_PLLP_DIV2; osc.PLL.PLLQ = 7;
  if (HAL_RCC_OscConfig(&osc) != HAL_OK) Error_Handler();
  clk.ClockType = RCC_CLOCKTYPE_HCLK | RCC_CLOCKTYPE_SYSCLK | RCC_CLOCKTYPE_PCLK1 | RCC_CLOCKTYPE_PCLK2;
  clk.SYSCLKSource = RCC_SYSCLKSOURCE_PLLCLK;
  clk.AHBCLKDivider = RCC_SYSCLK_DIV1;
  clk.APB1CLKDivider = RCC_HCLK_DIV4;
  clk.APB2CLKDivider = RCC_HCLK_DIV2;
  if (HAL_RCC_ClockConfig(&clk, FLASH_LATENCY_5) != HAL_OK) Error_Handler();
}

void nt_dwt_init(void)
{
  CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
  DWT->CYCCNT = 0;
  DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;
  SysTick->CTRL = 0;
}
__attribute__((used)) uint32_t HAL_GetTick(void)
{
  /* DWT 周期 → 毫秒：必须累积小数余数（否则快循环中 d/ticks_per_ms 恒 0 → 永不增长） */
  static uint32_t s_ms, s_frac, s_last;
  uint32_t now = DWT->CYCCNT;
  uint32_t d = now - s_last;
  s_last = now;
  s_frac += d;
  const uint32_t tpm = SystemCoreClock / 1000U; /* ticks per ms */
  if (s_frac >= tpm) {
    s_ms += s_frac / tpm;
    s_frac %= tpm;
  }
  return s_ms;
}

static void GPIO_Init_All(void)
{
  GPIO_InitTypeDef g = { 0 };
  __HAL_RCC_GPIOA_CLK_ENABLE(); __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_GPIOC_CLK_ENABLE(); __HAL_RCC_GPIOG_CLK_ENABLE();
  __HAL_RCC_GPIOH_CLK_ENABLE(); __HAL_RCC_GPIOI_CLK_ENABLE();

  g.Mode = GPIO_MODE_OUTPUT_PP; g.Pull = GPIO_NOPULL; g.Speed = GPIO_SPEED_FREQ_LOW;
  g.Pin = LED_R_PIN | LED_G_PIN | LED_B_PIN;
  HAL_GPIO_Init(GPIOH, &g);
  HAL_GPIO_WritePin(GPIOH, LED_R_PIN | LED_G_PIN | LED_B_PIN, GPIO_PIN_SET);
  g.Pin = PHY_RST_PIN;
  HAL_GPIO_Init(PHY_RST_PORT, &g);
  HAL_GPIO_WritePin(PHY_RST_PORT, PHY_RST_PIN, GPIO_PIN_RESET);

  g.Mode = GPIO_MODE_AF_PP; g.Pull = GPIO_NOPULL; g.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
  g.Alternate = GPIO_AF11_ETH;
  g.Pin = GPIO_PIN_1 | GPIO_PIN_4 | GPIO_PIN_5; HAL_GPIO_Init(GPIOC, &g);
  g.Pin = GPIO_PIN_1 | GPIO_PIN_2 | GPIO_PIN_7; HAL_GPIO_Init(GPIOA, &g);
  g.Pin = GPIO_PIN_11; HAL_GPIO_Init(GPIOB, &g);
  g.Pin = GPIO_PIN_13 | GPIO_PIN_14; HAL_GPIO_Init(GPIOG, &g);

  g.Alternate = GPIO_AF7_USART1;
  g.Pin = GPIO_PIN_9 | GPIO_PIN_10;
  HAL_GPIO_Init(GPIOA, &g);
}

static bool ETH_Init_Board(void)
{
  static uint8_t mac[6] = { NT_MAC0, NT_MAC1, NT_MAC2, NT_MAC3, NT_MAC4, NT_MAC5 };
  uint32_t id1, id2, bsr = 0, scsr;
  ETH_MACConfigTypeDef macCfg;

  HAL_GPIO_WritePin(PHY_RST_PORT, PHY_RST_PIN, GPIO_PIN_SET);
  HAL_Delay(150);
  __HAL_RCC_ETH_CLK_ENABLE();
  HAL_Delay(10);

  heth.Instance = ETH;
  heth.Init.MACAddr = mac;
  heth.Init.MediaInterface = HAL_ETH_RMII_MODE;
  heth.Init.TxDesc = DMATxDscrTab;
  heth.Init.RxDesc = DMARxDscrTab;
  heth.Init.RxBuffLen = 1536;
  if (HAL_ETH_Init(&heth) != HAL_OK) return false;

  if (HAL_ETH_ReadPHYRegister(&heth, NT_ETH_PHY_ADDRESS, NT_PHY_ID1, &id1) != HAL_OK ||
      HAL_ETH_ReadPHYRegister(&heth, NT_ETH_PHY_ADDRESS, NT_PHY_ID2, &id2) != HAL_OK ||
      (id1 & 0xFFFFU) != 0x0007U || (id2 & 0xFFF0U) != 0xC0F0U) return false;

  /* 关键修复：启用 PHY 自协商（LAN8720 上电默认可能禁用，BCR bit12=0 → 10M 半双工）。
   * 不启用时 PHY 以 10M 半双工运行而 MAC 配置 100M 全双工 → 速度不匹配 → 收不到帧。
   * 写 BCR：bit12=自协商使能 + bit9=重启自协商（0x1200）。 */
  {
    uint32_t bcr = 0;
    HAL_ETH_ReadPHYRegister(&heth, NT_ETH_PHY_ADDRESS, 0, &bcr);
    if ((bcr & 0x1000U) == 0U) { /* bit12 未设 → 启用自协商 */
      HAL_ETH_WritePHYRegister(&heth, NT_ETH_PHY_ADDRESS, 0, 0x1200U);
      HAL_Delay(100); /* 自协商重启后等待 */
    }
  }

  for (int i = 0; i < 30; i++) {
    HAL_Delay(100);
    if (HAL_ETH_ReadPHYRegister(&heth, NT_ETH_PHY_ADDRESS, NT_PHY_BSR, &bsr) != HAL_OK) return false;
    if ((bsr & (NT_PHY_LINK_BIT | NT_PHY_AN_DONE_BIT)) == (NT_PHY_LINK_BIT | NT_PHY_AN_DONE_BIT)) break;
  }
  if ((bsr & NT_PHY_LINK_BIT) == 0U) return false;

  if (HAL_ETH_ReadPHYRegister(&heth, NT_ETH_PHY_ADDRESS, NT_PHY_SCSR, &scsr) != HAL_OK) return false;
  if (HAL_ETH_GetMACConfig(&heth, &macCfg) != HAL_OK) return false;
  /* LAN8720 SCSR bits[4:2] 速度指示：010=10M / 100=100M。
   * 实测 bit2 解码不稳定（可能读到旧值/锁存值），PC 端 Realtek 已协商 100Mbps——
   * 强制 100M 全双工（与 GestureScreen apply_phy_mode 的最终模式一致） */
  (void)scsr;
  macCfg.Speed = ETH_SPEED_100M;
  macCfg.DuplexMode = ETH_FULLDUPLEX_MODE;
  macCfg.ChecksumOffload = DISABLE;
  if (HAL_ETH_SetMACConfig(&heth, &macCfg) != HAL_OK) return false;

  HAL_NVIC_SetPriority(ETH_IRQn, 6, 0);
  HAL_NVIC_EnableIRQ(ETH_IRQn);
  if (HAL_ETH_Start_IT(&heth) != HAL_OK) return false;
  nt_link_up = 1;
  return true;
}

static void UART1_Init(void)
{
  __HAL_RCC_USART1_CLK_ENABLE();
  USART1->BRR = 84000000U / 115200U;
  USART1->CR1 = USART_CR1_UE | USART_CR1_TE | USART_CR1_RE;
}
static void uart_putc(char c) { while ((USART1->SR & USART_SR_TXE) == 0U) {} USART1->DR = (uint8_t)c; }
static volatile uint8_t usb_ready = 0;
static void uart_puts(const char *s) {
  if (usb_ready) {
    uint16_t n = (uint16_t)strlen(s);
    if (n > 512) n = 512;
    CDC_Transmit_HS((uint8_t *)s, n);
    return;
  }
  while (*s != 0) uart_putc(*s++);
  while ((USART1->SR & USART_SR_TC) == 0U) {}
}

static char s_line[64];
static uint16_t s_lineLen;

/* USB CDC 接收环形缓冲（在 usbd_cdc_if.c 的 CDC_Receive_HS 中写入） */
extern volatile uint8_t usb_rx_buf[256];
extern volatile uint16_t usb_rx_head, usb_rx_tail;

static void uart_line_service(void)
{
  /* 1) USB CDC 输入（环形缓冲消费） */
  while (usb_rx_tail != usb_rx_head && (size_t)s_lineLen + 1 < sizeof(s_line)) {
    uint8_t ch = usb_rx_buf[usb_rx_tail];
    usb_rx_tail = (usb_rx_tail + 1) % sizeof(usb_rx_buf);
    if (ch != '\n' && ch != '\r') { s_line[s_lineLen++] = (char)ch; continue; }
    if (s_lineLen == 0) continue;
    goto process_line;
  }
  /* 2) USART1 输入（硬件寄存器轮询） */
  while ((size_t)s_lineLen + 1 < sizeof(s_line)) {
    if ((USART1->SR & USART_SR_RXNE) == 0U) break;
    uint8_t ch = (uint8_t)(USART1->DR & 0xFFU);
    if (ch != '\n' && ch != '\r') { s_line[s_lineLen++] = (char)ch; continue; }
    if (s_lineLen == 0) continue;
  process_line:
    s_line[s_lineLen] = '\0';
    char reply[160];
    int n = nt_line_reply(s_line, reply, sizeof(reply) - 2);
    if (n > 0) { reply[n] = '\r'; reply[n + 1] = '\n'; uart_puts(reply); }
    s_lineLen = 0;
  }
}

/* ---- 极简网络栈 ---- */
typedef struct nt_rx_buf {
  uint32_t used; uint16_t len; struct nt_rx_buf *next;
  uint8_t data[NT_FRAME_MAX];
} nt_rx_buf_t;

static nt_rx_buf_t s_rx[NT_RX_BUF_COUNT];
static nt_tx_buf_t s_tx[NT_TX_BUF_COUNT];
static const uint8_t s_mac[6] = { NT_MAC0, NT_MAC1, NT_MAC2, NT_MAC3, NT_MAC4, NT_MAC5 };
static const uint8_t s_ip[4] = { NT_IP0, NT_IP1, NT_IP2, NT_IP3 };
static uint8_t s_peer_mac[6];

void HAL_ETH_RxAllocateCallback(uint8_t **buffer)
{
  *buffer = NULL;
  for (unsigned i = 0; i < NT_RX_BUF_COUNT; i++) {
    if (s_rx[i].used == 0U) { s_rx[i].used=1; s_rx[i].len=0; s_rx[i].next=NULL; *buffer=s_rx[i].data; return; }
  }
}
void HAL_ETH_RxLinkCallback(void **start, void **end, uint8_t *buffer, uint16_t length)
{
  nt_rx_buf_t *rx = (nt_rx_buf_t *)(buffer - offsetof(nt_rx_buf_t, data));
  nt_rx_buf_t **head = (nt_rx_buf_t **)start, **tail = (nt_rx_buf_t **)end;
  rx->len = length <= NT_FRAME_MAX ? length : 0; rx->next = NULL;
  if (*head == NULL) *head = rx; else (*tail)->next = rx;
  *tail = rx;
}
void HAL_ETH_TxFreeCallback(uint32_t *buffer) { ((nt_tx_buf_t *)buffer)->used = 0U; }
void nt_rx_free_chain(nt_rx_buf_t *head) { while (head) { nt_rx_buf_t *n=head->next; head->used=0; head=n; } }

static uint16_t cksum(const uint8_t *p, uint16_t n)
{
  uint32_t s = 0;
  for (uint16_t i = 0; i + 1 < n; i += 2) s += ((uint16_t)p[i] << 8) | p[i+1];
  if (n & 1) s += (uint16_t)p[n-1] << 8;
  while (s >> 16) s = (s & 0xFFFF) + (s >> 16);
  return (uint16_t)(~s & 0xFFFF);
}
static void put16(uint8_t *p, uint16_t v) { p[0]=v>>8; p[1]=v; }
static uint16_t get16(const uint8_t *p) { return (uint16_t)((p[0]<<8)|p[1]); }
static uint32_t get32(const uint8_t *p) { return ((uint32_t)p[0]<<24)|((uint32_t)p[1]<<16)|((uint32_t)p[2]<<8)|p[3]; }
static void put32(uint8_t *p, uint32_t v) { p[0]=v>>24;p[1]=v>>16;p[2]=v>>8;p[3]=v; }

static bool nt_send(const uint8_t *frame, uint16_t len)
{
  nt_tx_buf_t *tx = NULL;
  for (unsigned i = 0; i < NT_TX_BUF_COUNT; i++) { if (s_tx[i].used==0) { s_tx[i].used=1; tx=&s_tx[i]; break; } }
  if (!tx) { nt_tx_fail_pool++; return false; }
  if (!nt_link_up) { nt_tx_fail_hal++; return false; }
  memcpy(tx->data, frame, len);
  ETH_BufferTypeDef b = { .buffer=tx->data, .len=len };
  ETH_TxPacketConfigTypeDef pkt = { 0 };
  pkt.Attributes = ETH_TX_PACKETS_FEATURES_CRCPAD;
  pkt.CRCPadCtrl = ETH_CRC_PAD_INSERT;
  pkt.Length = len; pkt.TxBuffer = &b; pkt.pData = tx;
  if (HAL_ETH_Transmit_IT(&heth, &pkt) != HAL_OK) { tx->used = 0; nt_tx_fail_hal++; return false; }
  nt_tx_ok++;
  nt_tx_packets++; return true;
}

void nt_input(const uint8_t *f, uint16_t len)
{
  if (len < 14) { nt_rx_errors++; return; }
  uint16_t et = get16(f+12);
  bool bc = memcmp(f, "\xFF\xFF\xFF\xFF\xFF\xFF", 6)==0;
  bool me = memcmp(f, s_mac, 6)==0;

  /* 帧分类诊断 */
  nt_last_etype = et; nt_last_len = len;
  if (bc) nt_bc_count++;
  if (et == 0x0806) nt_et_arp++;
  else if (et == 0x0800) nt_et_ipv4++;
  else nt_et_other++;
  { uint16_t cp = len < 64 ? len : 64;
    for (uint16_t i = 0; i < cp; i++) nt_last_frame[i] = f[i]; }

  if (et == 0x0806) { /* ARP */
    /* 诊断：捕获 ARP 目标 IP 与比较结果 */
    nt_arp_target_ip = get32(f+14+24); /* TPA 在 ARP 偏移 24（帧偏移 f+38），不是 28 */
    nt_arp_our_ip = get32(s_ip);
    if (len < 42 || get16(f+14+6) != 1) return;
    if ((bc||me) && get32(f+14+24) == get32(s_ip)) {
      nt_arp_seen++;
      memcpy(s_peer_mac, f+6, 6);
      uint8_t out[42]; uint8_t *a = out;
      memcpy(a, f+6, 6); memcpy(a+6, s_mac, 6); put16(a+12, 0x0806);
      put16(a+14,1); put16(a+16,0x0800); a[18]=6; a[19]=4; put16(a+20,2);
      memcpy(a+22, s_mac, 6); put32(a+28, get32(s_ip));
      memcpy(a+32, f+6, 6); put32(a+38, get32(f+14+14)); /* 回复请求方 SPA（帧偏移 f+28）*/
      nt_send(out, 42); nt_rx_packets++;
    }
    return;
  }
  if (et != 0x0800) return;
  const uint8_t *ip = f+14; uint16_t ipl = len-14;
  if (ipl < 20 || (ip[0]>>4) != 4 || get16(ip+2) > ipl || cksum(ip,20) != 0) { nt_rx_errors++; return; }
  if (get32(ip+16) != get32(s_ip) && get32(ip+16) != 0xFFFFFFFF) return;
  memcpy(s_peer_mac, f+6, 6); nt_rx_packets++;

  if (ip[9] == 1 && ipl >= 28 && ip[20] == 8) { nt_icmp_seen++; /* ICMP echo → reply */
    /* 方案：直接在接收缓冲区 in-place 修改请求帧→回发（与 lwIP 同思路，最可靠）
     * 交换 MAC/IP、type 8→0、重算校验和、TTL 不改（PC 不检查回显 TTL） */
    uint8_t *reply = (uint8_t *)f; /* RX 缓冲区可写（我们的池） */
    uint16_t total = get16(ip+2);
    /* 1. 交换以太网 MAC */
    uint8_t tmp6[6];
    memcpy(tmp6, reply, 6);
    memcpy(reply, reply+6, 6);
    memcpy(reply+6, tmp6, 6);
    /* 2. 交换 IP 源/目的 */
    uint8_t tmp4[4];
    memcpy(tmp4, reply+14+12, 4);
    memcpy(reply+14+12, reply+14+16, 4);
    memcpy(reply+14+16, tmp4, 4);
    /* 3. IP 头校验和：清零重算 */
    reply[14+10] = 0; reply[14+11] = 0;
    put16(reply+14+10, cksum(reply+14, 20));
    /* 4. ICMP type 8→0，校验和清零重算 */
    reply[14+20] = 0;
    reply[14+22] = 0; reply[14+23] = 0;
    put16(reply+14+22, cksum(reply+14+20, total-20));
    /* 5. 发送（保持原始帧长，含 padding） */
    if (nt_send(reply, len)) nt_icmp_tx++;
    return;
  }
  if (ip[9] == 17 && ipl >= 28 && get16(ip+20+2) == NT_UDP_PORT) { /* UDP → identity/PONG */
    uint16_t ul = get16(ip+20+4); if (ul < 8 || 20+ul > ipl) return;
    const char *pay = (const char*)(ip+20+8); uint16_t pl = ul-8;
    char req[64]; uint16_t n = pl < 63 ? pl : 63;
    for (uint16_t i=0;i<n;i++) req[i] = (pay[i]=='\r'||pay[i]=='\n') ? ' ' : pay[i];
    req[n]=0; while (n>0 && req[n-1]==' ') req[--n]=0;
    char rep[160]; int rl = nt_line_reply(req, rep, sizeof(rep)-1);
    if (rl > 0) {
      uint8_t out[14+20+8+160]; uint8_t *o = out;
      memcpy(o, s_peer_mac, 6); memcpy(o+6, s_mac, 6); put16(o+12, 0x0800);
      uint8_t *r = o+14; memset(r,0,20); r[0]=0x45; put16(r+2,28+rl); r[6]=0x40; r[8]=64; r[9]=17;
      memcpy(r+12, ip+16, 4); memcpy(r+16, ip+12, 4); put16(r+10, cksum(r,20));
      uint8_t *u = r+20;
      put16(u, get16(ip+20+2)); put16(u+2, get16(ip+20)); put16(u+4, 8+rl); put16(u+6, 0);
      memcpy(u+8, rep, rl);
      nt_send(out, 14+20+8+rl);
    }
  }
}

int nt_line_reply(const char *req, char *rep, size_t cap)
{
  char *o = rep; size_t left = cap;
  #define PS(s) do { size_t n=strlen(s); if(n>=left) return 0; memcpy(o,s,n); o+=n; left-=n; } while(0)
  if (strncmp(req,"HELLO",5)==0 || strcmp(req,"ID?")==0) {
    PS("NETTEST OK build="); PS(NT_BUILD_ID);
    PS(" mac=02:F4:29:14:00:0A ip=169.254.200.10 rx=");
    char t[11]; nt_fmt_u32(t,nt_rx_packets); PS(t);
    PS(" tx="); nt_fmt_u32(t,nt_tx_packets); PS(t);
    PS(" link="); PS(nt_link_up?"1":"0");
    return (int)(o-rep);
  }
  if (strncmp(req,"PING ",5)==0) {
    size_t n = strlen(req+5); if(!n || 5+n+7+strlen(NT_BUILD_ID)>=cap) return 0;
    memcpy(rep,"PONG ",5); memcpy(rep+5,req+5,n); memcpy(rep+5+n," build=",7);
    memcpy(rep+5+n+7, NT_BUILD_ID, strlen(NT_BUILD_ID));
    return 5+n+7+strlen(NT_BUILD_ID);
  }
  PS("ERR unknown-cmd"); return (int)(o-rep);
  #undef PS
}
int nt_fmt_u32(char *out, uint32_t v)
{
  char t[10]; int i=0,j=0;
  if(!v){out[0]='0';out[1]=0;return 1;}
  while(v){t[i++]='0'+v%10;v/=10;}
  while(i)out[j++]=t[--i]; out[j]=0; return j;
}

int main(void)
{
  nt_boot_magic = 0xC0FFEE42;
  nt_boot_count++;
  nt_boot_stage = 0;
  HAL_Init();
  nt_dwt_init();
  SystemClock_Config();
  nt_boot_stage = 1;
  GPIO_Init_All();
  nt_boot_stage = 2;
  MX_USB_DEVICE_Init(); /* USB CDC：COM4 串口 */
  HAL_Delay(2000);       /* 等 USB 枚举完成 */
  usb_ready = 1;         /* 切换输出到 CDC */
  bool ethOk = ETH_Init_Board();
  nt_boot_stage = ethOk ? 3 : 0xFE;
  UART1_Init();
  uart_puts("\r\n=== stm32f429-nettest (startup fixed) ===\r\n");
  uart_puts("build=" NT_BUILD_ID " ip=169.254.200.10 udp=5005 115200-8N1\r\n");
  uart_puts(ethOk ? "ETH: started\r\n" : "ETH: FAIL\r\n");
  if (!ethOk) Error_Handler();

  nt_boot_stage = 4;
  uint32_t lastBanner=0, lastBeat=0, lastGlow=0;
  for (;;) {
    uint32_t now = HAL_GetTick();
    for (;;) {
      nt_rx_buf_t *chain = NULL;
      if (HAL_ETH_ReadData(&heth, (void**)&chain) != HAL_OK || !chain) { if (chain) nt_rx_free_chain(chain); break; }
      for (nt_rx_buf_t *s = chain; s; s = s->next) {
        if (s->len >= 14 && s->len <= NT_FRAME_MAX) {
          nt_input(s->data, s->len);
          HAL_GPIO_WritePin(LED_B_PORT, LED_B_PIN, GPIO_PIN_RESET);
          lastGlow = now ? now : 1;
        } else nt_rx_errors++;
      }
      nt_rx_free_chain(chain);
    }
    (void)HAL_ETH_ReleaseTxPacket(&heth);
    uart_line_service();
    if (now - lastBeat >= 500) { lastBeat = now; HAL_GPIO_TogglePin(LED_G_PORT, LED_G_PIN); }
    if (lastGlow && now - lastGlow >= 30) { HAL_GPIO_WritePin(LED_B_PORT, LED_B_PIN, GPIO_PIN_SET); lastGlow = 0; }
    if (now - lastBanner >= 2000) {
      lastBanner = now;
      HAL_ETH_ReadPHYRegister(&heth, 0, 0, (uint32_t *)&nt_phy_bcr);
      HAL_ETH_ReadPHYRegister(&heth, 0, 1, (uint32_t *)&nt_phy_bsr);
      HAL_ETH_ReadPHYRegister(&heth, 0, 31, (uint32_t *)&nt_phy_scsr);
      char line[96]; char t[11]; char *o=line;
      const char *a = "NT b=" NT_BUILD_ID " l=";
      memcpy(o,a,strlen(a)); o+=strlen(a);
      *o++ = nt_link_up?'1':'0'; memcpy(o," rx=",4); o+=4;
      nt_fmt_u32(t,nt_rx_packets); memcpy(o,t,strlen(t)); o+=strlen(t);
      memcpy(o," tx=",4); o+=4;
      nt_fmt_u32(t,nt_tx_packets); memcpy(o,t,strlen(t)); o+=strlen(t);
      *o++='\r'; *o++='\n'; *o=0; uart_puts(line);
    }
  }
}
