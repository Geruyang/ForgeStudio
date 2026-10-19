/* 中断服务：SysTick（HAL 时基）与 ETH（RX/TX 完成） */
#include "stm32f4xx_hal.h"
#include "nettest.h"

extern ETH_HandleTypeDef heth; /* main.c */

void SysTick_Handler(void)
{
  HAL_IncTick();
}

void ETH_IRQHandler(void)
{
  HAL_ETH_IRQHandler(&heth);
}
