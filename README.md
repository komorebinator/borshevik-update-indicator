# Borshevik Update Indicator

GNOME Shell extension for Borshevik Linux — shows an icon among the system status icons (battery, sound, network) when a new OS image has been downloaded and a reboot will apply it, and nothing at all otherwise. Watches rpm-ostree's deployments over D-Bus, so it reacts to an update staged by the Image Manager and by automatic updates alike.

## Goals

- Show that a new image has been downloaded and will apply on reboot, without the user opening any application — including when automatic updates downloaded it
- Stay out of the way otherwise — no icon, no menu, no notifications, and no polling
