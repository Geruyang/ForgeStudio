/*
 * 时基：DWT CYCCNT 派生毫秒（覆盖弱符号 HAL_GetTick）。
 * 背景：实测 SysTick CSR 归零导致 HAL_Delay 永久挂起（根因未深究——DWT 方案
 * 使时基与任何中断无关，消除该依赖）。
 */
#include "stm32f4xx_hal.h"

extern uint32_t SystemCoreClock;

void nt_dwt_init(void)
{
  CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
  DWT->CYCCNT = 0;
  DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;
  SysTick->CTRL = 0; /* 不依赖 SysTick 中断 */
}

__attribute__((used)) uint32_t HAL_GetTick(void)
{
  static uint32_t s_ms;
  static uint32_t s_last;
  uint32_t now = DWT->CYCCNT;
  uint32_t d = now - s_last;
  s_last = now;
  s_ms += d / (SystemCoreClock / 1000U);
  return s_ms;
}
