# USB CDC 集成指南（待实现）

板卡 USB Device 口（COM4，STM32 原生 USB OTG HS Full Speed）。
GestureScreen 原工程正是通过此端口向 PC 传输图像。

## 硬件配置

| 项 | 值 |
|---|---|
| USB 外设 | **USB_OTG_HS**（Full Speed 模式，非 OTG_FS） |
| 引脚 | PB14 (DM) + PB15 (DP)，AF12 (OTG_HS_FS) |
| 时钟 | `__HAL_RCC_USB_OTG_HS_CLK_ENABLE()` |
| 中断 | OTG_HS_IRQn，优先级 5 |
| PC 端驱动 | **已装**（Windows 枚举为 COM4，VID 0483 PID 5740） |

## 需要的文件（已复制到本目录）

### USB 设备核心（Middlewares/USB/Core/）
- `usbd_core.c/h` — 设备核心状态机
- `usbd_ioreq.c/h` — 端点 I/O
- `usbd_ctlreq.c/h` — 控制请求（SETUP/IN/OUT）

### CDC 类（Middlewares/USB/CDC/）
- `usbd_cdc.c/h` — CDC ACM 类驱动

### HAL PCD 驱动（Drivers/STM32F4xx_HAL_Driver/Src/）
- `stm32f4xx_hal_pcd.c` — PCD 初始化/端点管理
- `stm32f4xx_hal_pcd_ex.c` — PCD 扩展
- `stm32f4xx_ll_usb.c` — 底层 USB 寄存器操作

### 用户文件（Inc/usb/，需适配）
- `usbd_desc.c/h` — 设备描述符（改为 ForgeStudio nettest）
- `usbd_cdc_if.c/h` — CDC 接口（改为串口输出）
- `usbd_conf.h` — USB 配置（缓冲区大小等）
- `usb_device.h` — 对外接口

### 需额外创建
- `usbd_conf.c` — HAL PCD MSP（GPIO PB14/PB15 + 时钟 + NVIC）
- `usb_device.c` — USB 设备初始化入口

## Makefile 增加

```make
# 新增源文件
SRC_C += Middlewares/USB/Core/Src/usbd_core.c \
         Middlewares/USB/Core/Src/usbd_ioreq.c \
         Middlewares/USB/Core/Src/usbd_ctlreq.c \
         Middlewares/USB/CDC/Src/usbd_cdc.c \
         Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal_pcd.c \
         Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal_pcd_ex.c \
         Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_ll_usb.c \
         Inc/usb/usbd_desc.c \
         Inc/usb/usbd_cdc_if.c

# 新增头文件路径
INCLUDES += -IMiddlewares/USB/Core/Inc \
            -IMiddlewares/USB/CDC/Inc \
            -IInc/usb
```

## main.c 集成

```c
// 1. GPIO 初始化中添加
__HAL_RCC_GPIOB_CLK_ENABLE();
GPIO_InitTypeDef g = {0};
g.Pin = GPIO_PIN_14 | GPIO_PIN_15;  // PB14 DM, PB15 DP
g.Mode = GPIO_MODE_AF_PP;
g.Pull = GPIO_NOPULL;
g.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
g.Alternate = GPIO_AF12_OTG_HS_FS;
HAL_GPIO_Init(GPIOB, &g);

// 2. 初始化 USB 设备
MX_USB_DEVICE_Init();

// 3. 串口输出改为 USB CDC
#include "usbd_cdc_if.h"
#define uart_puts(s) CDC_Transmit_FS((uint8_t*)s, strlen(s))

// 4. 中断处理
void OTG_HS_IRQHandler(void) {
  extern PCD_HandleTypeDef hpcd_USB_OTG_HS;
  HAL_PCD_IRQHandler(&hpcd_USB_OTG_HS);
}
```

## hal_conf.h 增加

```c
#define HAL_PCD_MODULE_ENABLED
#define HAL_USB_MODULE_ENABLED  // 如果存在
```

## 预期行为

固件启动后，USB Device 口被 PC 枚举为 COM4（CDC 串口）。
`uart_puts()` 输出通过 USB CDC 到 COM4。PC 端可用任何串口工具查看。

## 参考

GestureScreen 原工程的 USB 实现在：
- `USB_DEVICE/App/usb_device.c` — 初始化流程
- `USB_DEVICE/App/usbd_cdc_if.c` — CDC 收发
- `USB_DEVICE/Target/usbd_conf.c` — HAL PCD MSP（PB14/PB15 + OTG HS 时钟 + NVIC）
