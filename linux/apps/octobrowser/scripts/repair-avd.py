#!/usr/bin/env python3
"""Repair Android Studio AVD files without persisting Octo-only identity flags."""
from __future__ import annotations
import argparse
from pathlib import Path

PHONE = {
    "AvdId": "Nothing_Phone_2_API_35",
    "hw.device.name": "Nothing Phone (2)",
    "hw.device.manufacturer": "Nothing",
    "hw.lcd.width": "1080",
    "hw.lcd.height": "2412",
    "hw.lcd.density": "420",
    "hw.ramSize": "8192",
    "hw.cpu.ncore": "8",
    "hw.camera.back": "webcam0",
    "hw.camera.front": "webcam1",
    "hw.multi_display_window": "yes",
    "hw.display1.width": "1080",
    "hw.display1.height": "1920",
    "hw.display1.density": "420",
    "hw.display1.xOffset": "0",
    "hw.display1.yOffset": "0",
    "snapshot.present": "no",
    "fastboot.forceColdBoot": "yes",
}

def read_ini(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                values[key.strip()] = value.strip()
    return values

def write_ini(path: Path, values: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [f"{key}={value}" for key, value in sorted(values.items()) if not key.startswith("octobrowser.")]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("avd_dir", type=Path)
    parser.add_argument("--clean-config", action="store_true", help="normalize the config to the Nothing Phone (2) profile")
    args = parser.parse_args()
    avd = args.avd_dir.expanduser().resolve()
    config = avd / "config.ini"
    hardware = avd / "hardware-qemu.ini"
    values = read_ini(config)
    if args.clean_config:
        values.update(PHONE)
        # Keep a real image path if one already exists; never leave placeholders.
        values.setdefault("image.sysdir.1", "system-images/android-35/google_apis/x86_64/")
        values.setdefault("PlayStore.enabled", "false")
    else:
        values["snapshot.present"] = "no"
        values["fastboot.forceColdBoot"] = "yes"
    write_ini(config, values)
    if hardware.exists():
        hw = read_ini(hardware)
        hw["snapshot.present"] = "no"
        hw["fastboot.forceColdBoot"] = "yes"
        write_ini(hardware, hw)
    print(f"Repaired {config}")
    if hardware.exists(): print(f"Repaired {hardware}")

if __name__ == "__main__":
    main()
