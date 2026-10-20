# The bridge in a container (redroid)

Android in Docker ([redroid](https://github.com/remote-android/redroid-doc)) with `bridge-gate.apk`
installed and started by Android's own init. The bridge finds the LR512 by a UDP broadcast, so the
container must be on the LAN of the LR512: a macvlan network on a **wired** NIC of the docker host.

Needs on the host: Docker, the `binder_linux` kernel module (`sudo modprobe binder_linux devices=binder,hwbinder,vndbinder`).

```bash
cd android-bridge && ./build.sh          # bridge-gate.apk, if not there
docker build -f redroid/Dockerfile -t lightdeck-bridge .

docker network create -d macvlan --subnet=192.168.68.0/24 --gateway=192.168.68.1 \
  -o parent=<wired-nic> lan             # ipvlan (-d ipvlan -o ipvlan_mode=l2) if the NIC is Wi-Fi

docker run -d --name lightdeck-bridge --privileged --restart unless-stopped \
  --network lan --ip 192.168.68.<free address outside the DHCP pool> \
  -v lightdeck-bridge-data:/data \
  lightdeck-bridge \
  androidboot.redroid_width=480 androidboot.redroid_height=800 androidboot.redroid_dpi=160 \
  androidboot.redroid_gpu_mode=guest
```

Then `pnpm dev --bridge ws://192.168.68.<that address>:9010` from another machine (a macvlan
container cannot be reached from its own docker host without a macvlan shim interface).

Look at it: `docker exec lightdeck-bridge logcat -s LIGHTDECK LR512GATE`, or
`adb connect <that address>:5555`. The line to look for is `Searching for the LR512 (DasNet)...`
followed by the `SIUDI10A` device opening.

## Verified (2026-10-20, on the laptop, default docker network)

The image builds, Android boots, the apk is installed and started by `lightdeck-bridge.sh`, the
x86_64 vendor library loads, `setSoftware`/`initializeSushi` succeed, the WebSocket listens on
9010 and `eth0` is seen with its docker address.

## Not verified

Discovery of the LR512 from the container (needs the macvlan on a wired NIC), the authentication
of the vendor library towards the LR512 from a container, whether Android with no Wi-Fi interface
is enough for the library, and everything about timing.
