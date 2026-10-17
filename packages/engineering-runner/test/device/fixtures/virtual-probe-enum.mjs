#!/usr/bin/env node
// fixture 模拟测试——非实机验收。
// 虚拟探针枚举：向 stdout 打印 powershell Get-PnpDevice ... | ConvertTo-Json -Compress 的
// 模拟输出（USB\VID_xxxx&PID_xxxx 形态），供 enumerate.ts 的 parsePnpJsonOutput 解析测试。
// 用法：node virtual-probe-enum.mjs [--single]
//   默认输出 3 个设备的 JSON 数组（ST-Link 带 COM 口与真实序列号、CH340 无真实序列号、
//   CMSIS-DAP 探针无 COM 口）；--single 输出单对象（ConvertTo-Json 单元素降级形态）。
const rows = [
  {
    FriendlyName: 'ST-Link Virtual COM Port (COM7)',
    InstanceId: 'USB\\VID_0483&PID_3748\\00000000001A',
    Class: 'Ports',
    Status: 'OK',
  },
  {
    FriendlyName: 'USB-SERIAL CH340 (COM5)',
    InstanceId: 'USB\\VID_1A86&PID_7523\\6&27E5B6D&0&0000',
    Class: 'Ports',
    Status: 'OK',
  },
  {
    FriendlyName: 'CMSIS-DAP v1',
    InstanceId: 'USB\\VID_0D28&PID_0204\\H7GZ1M9A',
    Class: 'USB',
    Status: 'OK',
  },
];

const single = process.argv.includes('--single');
console.log(JSON.stringify(single ? rows[0] : rows));
