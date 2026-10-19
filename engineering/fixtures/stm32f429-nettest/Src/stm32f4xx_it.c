#include "stm32f4xx_hal.h"
extern ETH_HandleTypeDef heth;
void SysTick_Handler(void) { HAL_IncTick(); }
void ETH_IRQHandler(void) { HAL_ETH_IRQHandler(&heth); }

#include "usbd_conf.h"
extern PCD_HandleTypeDef hpcd_USB_OTG_HS;
void OTG_HS_IRQHandler(void) { HAL_PCD_IRQHandler(&hpcd_USB_OTG_HS); }
