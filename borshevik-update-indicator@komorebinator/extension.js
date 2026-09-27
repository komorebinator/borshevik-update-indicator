import GObject from 'gi://GObject';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { SystemIndicator } from 'resource:///org/gnome/shell/ui/quickSettings.js';

const BUS_NAME = 'org.projectatomic.rpmostree1';
const SYSROOT_PATH = '/org/projectatomic/rpmostree1/Sysroot';
const SYSROOT_IFACE = 'org.projectatomic.rpmostree1.Sysroot';
const ICON_NAME = 'software-update-available-symbolic';

// A reboot applies a new image when something is staged, or when the deployment
// that boots next (the first one) is not the running one.
function needsReboot(deployments) {
  if (!Array.isArray(deployments) || deployments.length === 0)
    return false;
  if (deployments.some((d) => d?.staged === true))
    return true;
  return deployments[0]?.booted !== true;
}

const UpdateIndicator = GObject.registerClass(
class UpdateIndicator extends SystemIndicator {
  constructor() {
    super();

    // The strip hides the whole indicator while none of its icons is visible.
    this._icon = this._addIndicator();
    this._icon.icon_name = ICON_NAME;
    this._icon.visible = false;
  }
});

export default class BorshevikUpdateIndicatorExtension extends Extension {
  enable() {
    this._indicator = new UpdateIndicator();
    Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

    this._proxySignalIds = [];
    this._cancellable = new Gio.Cancellable();

    // No DO_NOT_AUTO_START: rpm-ostreed is started if needed, so the state is
    // known right after login.
    Gio.DBusProxy.new_for_bus(
      Gio.BusType.SYSTEM,
      Gio.DBusProxyFlags.NONE,
      null,
      BUS_NAME,
      SYSROOT_PATH,
      SYSROOT_IFACE,
      this._cancellable,
      (_source, res) => {
        let proxy;
        try {
          proxy = Gio.DBusProxy.new_for_bus_finish(res);
        } catch (e) {
          if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            console.error(`[borshevik-update-indicator] cannot reach rpm-ostreed: ${e.message}`);
          return;
        }

        this._proxy = proxy;
        this._proxySignalIds = [
          proxy.connect('g-properties-changed', () => this._sync()),
          proxy.connect('notify::g-name-owner', () => this._sync()),
        ];
        this._sync();
      });
  }

  _sync() {
    // The daemon exits when idle and takes its cached properties with it; that
    // says nothing about the system, so keep the last known state.
    if (!this._proxy?.g_name_owner)
      return;

    const value = this._proxy.get_cached_property('Deployments');
    if (!value)
      return;

    this._indicator._icon.visible = needsReboot(value.recursiveUnpack());
  }

  disable() {
    this._cancellable?.cancel();
    this._cancellable = null;

    for (const id of this._proxySignalIds ?? [])
      this._proxy?.disconnect(id);
    this._proxySignalIds = [];
    this._proxy = null;

    this._indicator?.quickSettingsItems.forEach((item) => item.destroy());
    this._indicator?.destroy();
    this._indicator = null;
  }
}
