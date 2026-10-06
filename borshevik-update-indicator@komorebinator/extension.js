import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Gettext from 'gettext';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { SystemIndicator } from 'resource:///org/gnome/shell/ui/quickSettings.js';

const BUS_NAME = 'org.projectatomic.rpmostree1';
const SYSROOT_PATH = '/org/projectatomic/rpmostree1/Sysroot';
const SYSROOT_IFACE = 'org.projectatomic.rpmostree1.Sysroot';
const ICON_NAME = 'software-update-available-symbolic';
const RESTART_STYLE = 'borshevik-update-restart';
const POWER_ICON_NAME = 'system-shutdown-symbolic'; // GNOME's own on the power button

// GNOME's own "Restart…" in the power menu, as GNOME Shell shows it in this locale.
const restartLabel = () => Gettext.dgettext('gnome-shell', 'Restart…');

// GNOME Software's "Restart & Update…", translated by GNOME, without its mnemonic
// markers: "_" in most languages, "(_R)" in some, a stray "&" in Georgian.
const restartToUpdateLabel = () => Gettext.dgettext('gnome-software', '_Restart & Update…')
  .replace(/\(_.\)/, '').replace(/_/g, '').replace(/&(?=\S)/g, '').trim();

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

    // The power menu is built after the extension may already be enabled, so the
    // restart item is also brought up to date whenever Quick Settings opens.
    this._menuSignalId = Main.panel.statusArea.quickSettings.menu.connect('open-state-changed',
      (_menu, open) => {
        if (open)
          this._syncRestartItem();
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

    this._rebootPending = needsReboot(value.recursiveUnpack());
    this._indicator._icon.visible = this._rebootPending;
    this._syncRestartItem();
  }

  // GNOME's power button in Quick Settings and the "Restart…" item of its menu,
  // the item found by its label and both kept, since the label changes; null
  // until GNOME has built them. They live as long as the shell.
  _findPowerMenu() {
    if (this._restartItem)
      return true;
    const systemItem = Main.panel.statusArea.quickSettings._system?._systemItem;
    const menu = systemItem?.menu;
    const label = restartLabel();
    this._restartItem = menu?._getMenuItems().find((item) => item.label?.text === label) ?? null;
    this._powerButton = systemItem?.child.get_children().find((child) => child.menu === menu) ?? null;
    return this._restartItem !== null;
  }

  // While a reboot would apply a new image, GNOME's power button shows the update
  // icon and its restart item says so and stands out; the item still opens GNOME's
  // own restart dialog.
  _syncRestartItem(pending = this._rebootPending) {
    if (!this._findPowerMenu())
      return;
    const item = this._restartItem;
    item.label.text = pending ? restartToUpdateLabel() : restartLabel();
    if (pending)
      item.add_style_class_name(RESTART_STYLE);
    else
      item.remove_style_class_name(RESTART_STYLE);
    if (this._powerButton)
      this._powerButton.icon_name = pending ? ICON_NAME : POWER_ICON_NAME;
  }

  disable() {
    this._cancellable?.cancel();
    this._cancellable = null;

    if (this._menuSignalId)
      Main.panel.statusArea.quickSettings.menu.disconnect(this._menuSignalId);
    this._menuSignalId = 0;
    this._syncRestartItem(false);
    this._restartItem = null;
    this._powerButton = null;
    this._rebootPending = false;

    for (const id of this._proxySignalIds ?? [])
      this._proxy?.disconnect(id);
    this._proxySignalIds = [];
    this._proxy = null;

    this._indicator?.quickSettingsItems.forEach((item) => item.destroy());
    this._indicator?.destroy();
    this._indicator = null;
  }
}
