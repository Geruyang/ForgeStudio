# stm32f429-nettest 构建（GCC / xpack arm-none-eabi）
TARGET   = stm32f429-nettest
BUILD    = build
PREFIX   = arm-none-eabi-
CC       = $(PREFIX)gcc
CP       = $(PREFIX)objcopy
SZ       = $(PREFIX)size

CPU      = -mcpu=cortex-m4 -mthumb -mfpu=fpv4-sp-d16 -mfloat-abi=hard
DEFS     = -DSTM32F429xx -DUSE_HAL_DRIVER
INCLUDES = -IInc -IDrivers/CMSIS/Device/ST/STM32F4xx/Include -IDrivers/CMSIS/Include -IDrivers/STM32F4xx_HAL_Driver/Inc
CFLAGS   = $(CPU) $(DEFS) $(INCLUDES) $(EXTRA) -O2 -g -Wall -Wextra -ffunction-sections -fdata-sections -fno-common
LDFLAGS  = $(CPU) -TSTM32F429IGTx.ld -Wl,--gc-sections -Wl,-Map=$(BUILD)/$(TARGET).map,--cref -specs=nano.specs -specs=nosys.specs

SRC_C  = Src/main.c Src/stm32f4xx_it.c Src/system_stm32f4xx.c \
         Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal.c \
         Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal_rcc.c \
         Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal_rcc_ex.c \
         Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal_gpio.c \
         Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal_cortex.c \
         Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal_dma.c \
         Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal_eth.c \
         Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal_pwr.c
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
