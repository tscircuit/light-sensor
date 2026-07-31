from machine import I2C, Pin
from time import sleep_ms

# Enable power to the Feather's STEMMA QT connector.
i2c_power = Pin(7, Pin.OUT, value=1)
sleep_ms(10)

# Adafruit Feather ESP32-S3 I2C pins.
i2c = I2C(
    0,
    sda=Pin(3),
    scl=Pin(4),
    freq=400_000,
)

# The BH1750 uses 0x23 normally or 0x5C with its address jumper closed.
devices = i2c.scan()
address = next(
    (device for device in (0x23, 0x5C) if device in devices),
    None,
)

if address is None:
    raise OSError(
        "BH1750 not found. I2C devices: {}".format(
            [hex(device) for device in devices]
        )
    )

# Continuous low-resolution mode: 4 lux resolution, 16 ms typical.
i2c.writeto(address, b"\x13")
sleep_ms(24)

print("BH1750 detected at", hex(address))

while True:
    data = i2c.readfrom(address, 2)
    raw_value = (data[0] << 8) | data[1]
    lux = raw_value / 1.2

    print("Light: {:.2f} lux".format(lux))
    sleep_ms(16)
