# stm32f429-nettest 构建（GCC + USB CDC）
TARGET   = stm32f429-nettest
BUILD    = build
PREFIX   = arm-none-eabi-
CC       = $(PREFIX)gcc
CP       = $(PREFIX)objcopy
SZ       = $(PREFIX)size

CPU      = -mcpu=cortex-m4 -mthumb -mfpu=fpv4-sp-d16 -mfloat-abi=hard
DEFS     = -DSTM32F429xx -DUSE_HAL_DRIVER
INCLUDES = -IInc -IDrivers/CMSIS/Device/ST/STM32F4xx/Include -IDrivers/CMSIS/Include \
           -IDrivers/STM32F4xx_HAL_Driver/Inc \
           -IMiddlewares/USB/Core/Inc -IMiddlewares/USB/CDC/Inc -IInc/usb
CFLAGS   = $(CPU) $(DEFS) $(INCLUDES) $(EXTRA) -O2 -g -Wall -Wextra -ffunction-sections -fdata-sections -fno-common
LDFLAGS  = $(CPU) -TSTM32F429IGTx.ld -Wl,--gc-sections -Wl,-Map=$(BUILD)/$(TARGET).map,--cref -specs=nano.specs -specs=nosys.specs

HAL_SRC = Drivers/STM32F4xx_HAL_Driver/Src
USB_CORE = Middlewares/USB/Core/Src
USB_CDC  = Middlewares/USB/CDC/Src

SRC_C  = Src/main.c Src/stm32f4xx_it.c Src/system_stm32f4xx.c \
         $(HAL_SRC)/stm32f4xx_hal.c \
         $(HAL_SRC)/stm32f4xx_hal_rcc.c \
         $(HAL_SRC)/stm32f4xx_hal_rcc_ex.c \
         $(HAL_SRC)/stm32f4xx_hal_gpio.c \
         $(HAL_SRC)/stm32f4xx_hal_cortex.c \
         $(HAL_SRC)/stm32f4xx_hal_dma.c \
         $(HAL_SRC)/stm32f4xx_hal_eth.c \
         $(HAL_SRC)/stm32f4xx_hal_pwr.c \
         $(HAL_SRC)/stm32f4xx_hal_pcd.c \
         $(HAL_SRC)/stm32f4xx_hal_pcd_ex.c \
         $(HAL_SRC)/stm32f4xx_ll_usb.c \
         $(USB_CORE)/usbd_core.c \
         $(USB_CORE)/usbd_ioreq.c \
         $(USB_CORE)/usbd_ctlreq.c \
         $(USB_CDC)/usbd_cdc.c \
         Inc/usb/usb_device.c \
         Inc/usb/usbd_desc.c \
         Inc/usb/usbd_cdc_if.c \
         Inc/usb/usbd_conf.c
SRC_S  = startup_stm32f429xx.s
OBJ    = $(patsubst %.c,$(BUILD)/%.o,$(SRC_C)) $(BUILD)/$(SRC_S:.s=.o)

.PHONY: all clean flash verify size
all: $(BUILD)/$(TARGET).elf $(BUILD)/$(TARGET).bin $(BUILD)/$(TARGET).hex size

$(BUILD)/%.o: %.c
	@mkdir -p $(dir $@)
	$(CC) -c $(CFLAGS) $< -o $@

$(BUILD)/%.o: %.s
	@mkdir -p $(dir $@)
	$(CC) -c $(CFLAGS) -x assembler-with-cpp $< -o $@

$(BUILD)/$(TARGET).elf: $(OBJ)
	$(CC) $(OBJ) $(LDFLAGS) -o $@

$(BUILD)/$(TARGET).bin: $(BUILD)/$(TARGET).elf
	$(CP) -O binary $< $@

$(BUILD)/$(TARGET).hex: $(BUILD)/$(TARGET).elf
	$(CP) -O ihex $< $@

flash: $(BUILD)/$(TARGET).elf
	probe-rs download --chip STM32F429IG --verify $(BUILD)/$(TARGET).elf

verify: $(BUILD)/$(TARGET).elf
	probe-rs verify --chip STM32F429IG $(BUILD)/$(TARGET).elf

size: $(BUILD)/$(TARGET).elf
	$(SZ) $<

clean:
	rm -rf $(BUILD)
