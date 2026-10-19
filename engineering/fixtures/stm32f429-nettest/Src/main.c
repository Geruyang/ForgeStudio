/*
 * stm32f429-nettest 主程序（野火挑战者 V1）
 * 时钟：HSE 25MHz → SYSCLK 168MHz（M25 N336 P2 Q7），APB1 42 / APB2 84。
 * 板级事实（GestureScreen 实证）：LAN8720 nRST=PI1；RMII 引脚 AF11
 * PC1/PA1/PA2/PA7/PC4/PC5/PB11/PG13/PG14；PHY 地址 0；RGB LED PH10/11/12 共阳。
 * 时基 DWT（tick.c 覆盖 HAL_GetTick），不依赖 SysTick 中断。
 */
#include <string.h>
#include "stm32f4xx_hal.h"
#include "nettest.h"

ETH_HandleTypeDef heth;
ETH_DMADescTypeDef DMARxDscrTab[ETH_RX_DESC_CNT];
ETH_DMADescTypeDef DMATxDscrTab[ETH_TX_DESC_CNT];

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

static void Error_Handler(void)
{
  __disable_irq();
  for (;;) {
    HAL_GPIO_TogglePin(LED_R_PORT, LED_R_PIN);
    for (volatile int i = 0; i < 4000000; i++) __NOP();
  }
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
  osc.PLL.PLLM = 25;
  osc.PLL.PLLN = 336;
  osc.PLL.PLLP = RCC_PLLP_DIV2;
  osc.PLL.PLLQ = 7;
  if (HAL_RCC_OscConfig(&osc) != HAL_OK) Error_Handler();
  clk.ClockType = RCC_CLOCKTYPE_HCLK | RCC_CLOCKTYPE_SYSCLK | RCC_CLOCKTYPE_PCLK1 | RCC_CLOCKTYPE_PCLK2;
  clk.SYSCLKSource = RCC_SYSCLKSOURCE_PLLCLK;
  clk.AHBCLKDivider = RCC_SYSCLK_DIV1;
  clk.APB1CLKDivider = RCC_HCLK_DIV4;
  clk.APB2CLKDivider = RCC_HCLK_DIV2;
  if (HAL_RCC_ClockConfig(&clk, FLASH_LATENCY_5) != HAL_OK) Error_Handler();
}

static void GPIO_Init_All(void)
{
  GPIO_InitTypeDef g = { 0 };
  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_GPIOC_CLK_ENABLE();
  __HAL_RCC_GPIOG_CLK_ENABLE();
  __HAL_RCC_GPIOH_CLK_ENABLE();
  __HAL_RCC_GPIOI_CLK_ENABLE();

  g.Mode = GPIO_MODE_OUTPUT_PP;
  g.Pull = GPIO_NOPULL;
  g.Speed = GPIO_SPEED_FREQ_LOW;
  g.Pin = LED_R_PIN | LED_G_PIN | LED_B_PIN;
  HAL_GPIO_Init(GPIOH, &g);
  HAL_GPIO_WritePin(GPIOH, LED_R_PIN | LED_G_PIN | LED_B_PIN, GPIO_PIN_SET);

  g.Pin = PHY_RST_PIN;
  HAL_GPIO_Init(PHY_RST_PORT, &g);
  HAL_GPIO_WritePin(PHY_RST_PORT, PHY_RST_PIN, GPIO_PIN_RESET);

  g.Mode = GPIO_MODE_AF_PP;
  g.Pull = GPIO_NOPULL;
  g.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
  g.Alternate = GPIO_AF11_ETH;
  g.Pin = GPIO_PIN_1 | GPIO_PIN_4 | GPIO_PIN_5;   /* PC1 MDC, PC4 RXD0, PC5 RXD1 */
  HAL_GPIO_Init(GPIOC, &g);
  g.Pin = GPIO_PIN_1 | GPIO_PIN_2 | GPIO_PIN_7;   /* PA1 REF_CLK, PA2 MDIO, PA7 CRS_DV */
  HAL_GPIO_Init(GPIOA, &g);
  g.Pin = GPIO_PIN_11;                            /* PB11 TX_EN */
  HAL_GPIO_Init(GPIOB, &g);
  g.Pin = GPIO_PIN_13 | GPIO_PIN_14;              /* PG13 TXD0, PG14 TXD1 */
  HAL_GPIO_Init(GPIOG, &g);

  g.Alternate = GPIO_AF7_USART1;
  g.Pin = GPIO_PIN_9 | GPIO_PIN_10;               /* USART1 TX/RX */
  HAL_GPIO_Init(GPIOA, &g);
}

static bool ETH_Init_Board(void)
{
  static uint8_t mac[6] = { NT_MAC0, NT_MAC1, NT_MAC2, NT_MAC3, NT_MAC4, NT_MAC5 };
  uint32_t id1, id2, bsr = 0, scsr;
  ETH_MACConfigTypeDef macCfg;

  __HAL_RCC_ETH_CLK_ENABLE();
  HAL_Delay(5);
  HAL_GPIO_WritePin(PHY_RST_PORT, PHY_RST_PIN, GPIO_PIN_SET); /* 释放 PHY 复位（REF_CLK 起振） */
  HAL_Delay(50);

  heth.Instance = ETH;
  heth.Init.MACAddr = mac;
  heth.Init.MediaInterface = HAL_ETH_RMII_MODE;
  heth.Init.TxDesc = DMATxDscrTab;
  heth.Init.RxDesc = DMARxDscrTab;
  heth.Init.RxBuffLen = 1536;
  if (HAL_ETH_Init(&heth) != HAL_OK) return false;

  /* LAN8720：ID1=0x0007，ID2 高 12 位 0xC0F */
  if (HAL_ETH_ReadPHYRegister(&heth, NT_ETH_PHY_ADDRESS, NT_PHY_ID1, &id1) != HAL_OK ||
      HAL_ETH_ReadPHYRegister(&heth, NT_ETH_PHY_ADDRESS, NT_PHY_ID2, &id2) != HAL_OK ||
      (id1 & 0xFFFFU) != 0x0007U || (id2 & 0xFFF0U) != 0xC0F0U) return false;

  /* 等自协商 + 链路（最多约 6 秒；BSR latched-low 以末次读为准） */
  for (int i = 0; i < 60; i++) {
    HAL_Delay(100);
    if (HAL_ETH_ReadPHYRegister(&heth, NT_ETH_PHY_ADDRESS, NT_PHY_BSR, &bsr) != HAL_OK) return false;
    if ((bsr & (NT_PHY_LINK_BIT | NT_PHY_AN_DONE_BIT)) == (NT_PHY_LINK_BIT | NT_PHY_AN_DONE_BIT)) break;
  }
  if ((bsr & NT_PHY_LINK_BIT) == 0U) return false;

  if (HAL_ETH_ReadPHYRegister(&heth, NT_ETH_PHY_ADDRESS, NT_PHY_SCSR, &scsr) != HAL_OK) return false;
  if (HAL_ETH_GetMACConfig(&heth, &macCfg) != HAL_OK) return false;
  macCfg.Speed = (scsr & 0x0004U) != 0U ? ETH_SPEED_10M : ETH_SPEED_100M;
  macCfg.DuplexMode = (scsr & 0x0010U) != 0U ? ETH_FULLDUPLEX_MODE : ETH_HALFDUPLEX_MODE;
  macCfg.ChecksumOffload = DISABLE;
  if (HAL_ETH_SetMACConfig(&heth, &macCfg) != HAL_OK) return false;

  HAL_NVIC_SetPriority(ETH_IRQn, 6, 0);
  HAL_NVIC_EnableIRQ(ETH_IRQn);
  if (HAL_ETH_Start_IT(&heth) != HAL_OK) return false;
  nt_link_up = 1;
  return true;
}

/* USART1：直接寄存器（仓库 HAL 未带 UART 源），115200-8N1，PCLK2=84MHz */
static void UART1_Init(void)
{
  __HAL_RCC_USART1_CLK_ENABLE();
  USART1->BRR = 84000000U / 115200U;
  USART1->CR1 = USART_CR1_UE | USART_CR1_TE | USART_CR1_RE;
}

static void uart_putc(char c)
{
  while ((USART1->SR & USART_SR_TXE) == 0U) {}
  USART1->DR = (uint8_t)c;
}
static void uart_puts(const char *s)
{
  while (*s != 0) uart_putc(*s++);
  while ((USART1->SR & USART_SR_TC) == 0U) {}
}

static char s_line[64];
static uint16_t s_lineLen;
static void uart_line_service(void)
{
  while ((size_t)s_lineLen + 1 < sizeof(s_line)) {
    if ((USART1->SR & USART_SR_RXNE) == 0U) break;
    uint8_t ch = (uint8_t)(USART1->DR & 0xFFU);
    if (ch != '\n' && ch != '\r') { s_line[s_lineLen++] = (char)ch; continue; }
    if (s_lineLen == 0) continue;
    s_line[s_lineLen] = '\0';
    char reply[160];
    int n = nt_line_reply(s_line, reply, sizeof(reply) - 2);
    if (n > 0) { reply[n] = '\r'; reply[n + 1] = '\n'; uart_puts(reply); }
    s_lineLen = 0;
  }
}

int main(void)
{
  nt_boot_magic = 0xC0FFEE42U;
  nt_boot_count++;
  nt_boot_stage = 0;
  HAL_Init();
  nt_dwt_init();
  SystemClock_Config();
  nt_boot_stage = 1;
  GPIO_Init_All();
  nt_boot_stage = 2;
  bool ethOk = ETH_Init_Board();
  nt_boot_stage = ethOk ? 3U : 0xFEU;
  UART1_Init();
  uart_puts("\r\n=== stm32f429-nettest ===\r\n");
  uart_puts("build=" NT_BUILD_ID " ip=169.254.200.10 udp=5005 115200-8N1\r\n");
  uart_puts(ethOk ? "ETH: started (LAN8720 link up)\r\n" : "ETH: INIT FAILED (red LED blink)\r\n");
  if (!ethOk) Error_Handler();

  nt_boot_stage = 4;
  uint32_t lastBanner = 0, lastBeat = 0, lastRxGlow = 0;
  for (;;) {
    uint32_t now = HAL_GetTick();

    /* RX：读完整帧链 → 逐段处理 → 释放；TX 完成后回收描述符 */
    for (;;) {
      nt_rx_buf_t *chain = NULL;
      if (HAL_ETH_ReadData(&heth, (void **)&chain) != HAL_OK || chain == NULL) {
        if (chain != NULL) nt_rx_free_chain(chain);
        break;
      }
      for (nt_rx_buf_t *seg = chain; seg != NULL; seg = seg->next) {
        if (seg->len >= 14 && seg->len <= NT_FRAME_MAX) {
          nt_input(seg->data, seg->len);
          HAL_GPIO_WritePin(LED_B_PORT, LED_B_PIN, GPIO_PIN_RESET);
          lastRxGlow = now ? now : 1;
        } else {
          nt_rx_errors++;
        }
      }
      nt_rx_free_chain(chain);
    }
    (void)HAL_ETH_ReleaseTxPacket(&heth);

    uart_line_service();

    if (now - lastBeat >= 500) {
      lastBeat = now;
      HAL_GPIO_TogglePin(LED_G_PORT, LED_G_PIN);
    }
    if (lastRxGlow != 0 && now - lastRxGlow >= 30) {
      HAL_GPIO_WritePin(LED_B_PORT, LED_B_PIN, GPIO_PIN_SET);
      lastRxGlow = 0;
    }
    if (now - lastBanner >= 2000) {
      lastBanner = now;
      char line[96];
      char t[11];
      char *o = line;
      const char *a = "NETTEST build=" NT_BUILD_ID " link=";
      size_t al = strlen(a);
      memcpy(o, a, al); o += al;
      *o++ = nt_link_up ? '1' : '0';
      memcpy(o, " rx=", 4); o += 4;
      nt_fmt_u32(t, nt_rx_packets);
      size_t n = strlen(t); memcpy(o, t, n); o += n;
      memcpy(o, " tx=", 4); o += 4;
      nt_fmt_u32(t, nt_tx_packets);
      n = strlen(t); memcpy(o, t, n); o += n;
      *o++ = '\r'; *o++ = '\n'; *o = '\0';
      uart_puts(line);
    }
  }
}
