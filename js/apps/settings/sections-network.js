/**
 * js/apps/settings/sections-network.js — Wi-Fi, Network and Bluetooth panels.
 *
 * No real radios exist behind these controls; the device lists are fixed
 * simulations, but every toggle and every selection persists through
 * `settings` and emits `settings:change` like any other panel.
 */

import { h, svg } from '../../core/dom.js';
import { bus } from '../../core/bus.js';
import { notify } from '../../core/notify.js';
import { dialog } from '../../core/dialog.js';
import { users } from '../../core/users.js';
import { settings } from './state.js';
import {
  prefPage,
  prefGroup,
  prefCard,
  actionRow,
  switchRow,
  comboRow,
  buttonRow,
  entryRow,
  infoRow,
  button,
  switchControl,
} from './widgets.js';

const icon = (paths) => () => svg(paths, { size: 16, strokeWidth: 1.7 });

/* ------------------------------------------------------------------ *
 * Wi-Fi
 * ------------------------------------------------------------------ */

const NETWORKS = [
  { ssid: 'Ubuntu-Guest', strength: 4, secure: true, band: '5 GHz · WPA2' },
  { ssid: 'Noble-Numbat', strength: 3, secure: true, band: '5 GHz · WPA3' },
  { ssid: 'CafeWiFi', strength: 3, secure: false, band: '2.4 GHz · Open' },
  { ssid: 'BT-HH8821', strength: 2, secure: true, band: '2.4 GHz · WPA2' },
  { ssid: 'VM1234567', strength: 2, secure: true, band: '5 GHz · WPA2' },
  { ssid: 'eduroam', strength: 1, secure: true, band: '5 GHz · WPA2 Enterprise' },
];

function signalBars(strength) {
  const box = h('span.signal', { 'aria-label': `Signal strength ${strength} of 4` });
  for (let i = 1; i <= 4; i += 1) {
    const bar = h('span.signal__bar');
    if (i <= strength) bar.classList.add('is-on');
    box.appendChild(bar);
  }
  return box;
}

export const wifiSection = {
  id: 'wifi',
  title: 'Wi-Fi',
  icon: icon(['M2 8.5a15 15 0 0 1 20 0', 'M5 12a11 11 0 0 1 14 0', 'M8.5 15.5a6 6 0 0 1 7 0', 'M12 19h.01']),
  keywords: 'wifi wireless network ssid hotspot signal',
  build() {
    const listGroup = h('div');

    function renderList() {
      const enabled = settings.get('wifi.enabled') === true;
      const connected = settings.get('wifi.connected');
      const rows = [];

      if (!enabled) {
        rows.push(
          actionRow({
            title: 'Wi-Fi is turned off',
            subtitle: 'Turn on Wi-Fi to see the networks in range',
            keywords: 'wifi off disabled',
          }),
        );
      } else {
        for (const network of NETWORKS) {
          const isConnected = network.ssid === connected;
          const suffix = h('div.network-row__suffix');
          if (network.secure) suffix.appendChild(h('span.network-row__lock', { 'aria-label': 'Secured', text: '🔒' }));
          suffix.appendChild(signalBars(network.strength));
          suffix.appendChild(
            isConnected
              ? h('span.adw-row__value', { text: 'Connected' })
              : button({
                  label: 'Connect',
                  onClick: () => {
                    settings.set('wifi.connected', network.ssid);
                    bus.emit('net:online', {});
                    notify.show({
                      app: 'Network',
                      title: 'Connected to Wi-Fi',
                      body: `You are now connected to “${network.ssid}”.`,
                    });
                    renderList();
                  },
                }),
          );

          rows.push(
            actionRow({
              title: network.ssid,
              subtitle: isConnected ? `Connected · ${network.band}` : network.band,
              class: isConnected ? 'network-row is-connected' : 'network-row',
              suffix,
              keywords: `wifi network ${network.ssid}`,
            }),
          );
        }
      }

      const group = prefGroup({ title: 'Visible Networks' }, ...rows);
      listGroup.replaceChildren(group);
    }

    renderList();

    return prefPage(
      { title: 'Wi-Fi' },
      prefGroup(
        {},
        switchRow({
          title: 'Wi-Fi',
          subtitle: 'Intel Wi-Fi 6 AX201 160MHz',
          value: settings.get('wifi.enabled') === true,
          onChange: (v) => {
            settings.set('wifi.enabled', v);
            if (!v) {
              settings.set('wifi.connected', '');
              bus.emit('net:offline', {});
            }
            renderList();
          },
          keywords: 'wifi enable turn on off',
        }),
      ),
      listGroup,
      prefGroup(
        {},
        buttonRow({
          title: 'Connect to Hidden Network',
          subtitle: 'Join a network that does not broadcast its name',
          label: 'Connect…',
          onClick: async () => {
            const ssid = await dialog.prompt({
              title: 'Connect to Hidden Wi-Fi Network',
              body: 'Enter the name and security details of the hidden network you wish to connect to.',
              placeholder: 'Network name (SSID)',
              okLabel: 'Connect',
            });
            if (ssid === null || ssid.trim() === '') return;
            settings.set('wifi.enabled', true);
            settings.set('wifi.connected', ssid.trim());
            renderList();
            notify.show({ app: 'Network', title: 'Connected to Wi-Fi', body: `You are now connected to “${ssid.trim()}”.` });
          },
          keywords: 'hidden network ssid connect',
        }),
        buttonRow({
          title: 'Wi-Fi Hotspot',
          subtitle: 'Share this computer’s connection with other devices',
          label: 'Turn On…',
          onClick: () =>
            dialog.alert({
              title: 'Turn On Wi-Fi Hotspot?',
              body:
                'Wi-Fi will be disconnected while the hotspot is active. ' +
                'This simulated adapter cannot actually share a connection.',
            }),
          keywords: 'hotspot share tethering',
        }),
      ),
    );
  },
};

/* ------------------------------------------------------------------ *
 * Network
 * ------------------------------------------------------------------ */

export const networkSection = {
  id: 'network',
  title: 'Network',
  icon: icon(['M3 6h18v9H3z', 'M8 19h8', 'M12 15v4']),
  keywords: 'network wired ethernet vpn proxy dns ip address',
  build() {
    const proxyHost = entryRow({
      title: 'HTTP Proxy',
      value: settings.get('network.proxyHost'),
      placeholder: 'proxy.example.com',
      onCommit: (v) => settings.set('network.proxyHost', v.trim()),
      keywords: 'proxy host http',
      disabled: settings.get('network.proxyMode') !== 'manual',
    });

    const proxyPort = entryRow({
      title: 'HTTP Proxy Port',
      value: String(settings.get('network.proxyPort')),
      placeholder: '8080',
      onCommit: (v) => {
        const port = Number.parseInt(v, 10);
        settings.set('network.proxyPort', Number.isFinite(port) && port > 0 && port < 65536 ? port : 8080);
        proxyPort.input.value = String(settings.get('network.proxyPort'));
      },
      keywords: 'proxy port',
      disabled: settings.get('network.proxyMode') !== 'manual',
    });

    const wiredSwitch = switchControl({
      value: settings.get('network.wiredEnabled') === true,
      label: 'Wired connection',
      onChange: (v) => settings.set('network.wiredEnabled', v),
    });

    const wiredRow = actionRow({
      title: 'Wired Connection 1',
      subtitle: settings.get('network.wiredEnabled') ? 'Connected · 1000 Mb/s' : 'Cable unplugged',
      suffix: h(
        'div.network-row__suffix',
        {},
        wiredSwitch,
        button({
          label: 'Settings',
          onClick: () =>
            dialog.alert({
              title: 'Wired Connection 1',
              body: [
                'IPv4 Address\t192.168.1.42',
                'Subnet Mask\t255.255.255.0',
                'Default Route\t192.168.1.1',
                'DNS\t\t127.0.0.53 (systemd-resolved)',
                'Hardware Address\t3C:52:82:1A:7D:9E',
                'Link Speed\t1000 Mb/s',
                'MTU\t\t1500',
              ].join('\n'),
              okLabel: 'Close',
            }),
        }),
      ),
      keywords: 'wired ethernet connection',
    });

    return prefPage(
      { title: 'Network' },
      prefGroup({ title: 'Wired' }, wiredRow),
      prefGroup(
        { title: 'Connection Details' },
        infoRow('IPv4 Address', '192.168.1.42', { keywords: 'ip address ipv4' }),
        infoRow('IPv6 Address', 'fe80::3e52:82ff:fe1a:7d9e', { keywords: 'ip address ipv6' }),
        infoRow('Hardware Address', '3C:52:82:1A:7D:9E', { keywords: 'mac hardware address' }),
        infoRow('Default Route', '192.168.1.1', { keywords: 'gateway route' }),
        infoRow('DNS', '127.0.0.53', { keywords: 'dns resolver' }),
        infoRow('Hostname', users.hostname, { keywords: 'hostname' }),
      ),
      prefGroup(
        { title: 'VPN', description: 'Virtual private networks let you connect to a remote network securely.' },
        actionRow({ title: 'Not set up', keywords: 'vpn none' }),
        buttonRow({
          title: 'Add VPN',
          label: 'Add…',
          onClick: () =>
            dialog.alert({
              title: 'Add VPN',
              body:
                'OpenVPN, WireGuard and PPTP configurations are imported from a file. ' +
                'This simulated session has no NetworkManager backend to import into.',
            }),
          keywords: 'vpn add openvpn wireguard',
        }),
      ),
      prefGroup(
        { title: 'Proxy' },
        comboRow({
          title: 'Network Proxy',
          value: settings.get('network.proxyMode'),
          options: [
            { value: 'none', label: 'Disabled' },
            { value: 'manual', label: 'Manual' },
            { value: 'auto', label: 'Automatic' },
          ],
          onChange: (v) => {
            settings.set('network.proxyMode', v);
            proxyHost.input.disabled = v !== 'manual';
            proxyPort.input.disabled = v !== 'manual';
          },
          keywords: 'proxy mode manual automatic',
        }),
        proxyHost.row,
        proxyPort.row,
      ),
    );
  },
};

/* ------------------------------------------------------------------ *
 * Bluetooth
 * ------------------------------------------------------------------ */

const BLUETOOTH_DEVICES = [
  { id: 'wh-1000xm4', name: 'WH-1000XM4', type: 'Headphones', paired: true },
  { id: 'mx-master-3', name: 'MX Master 3', type: 'Mouse', paired: true },
  { id: 'k380', name: 'Keyboard K380', type: 'Keyboard', paired: false },
  { id: 'pixel-buds', name: 'Pixel Buds Pro', type: 'Earbuds', paired: false },
];

export const bluetoothSection = {
  id: 'bluetooth',
  title: 'Bluetooth',
  icon: icon(['M7 7l10 10-5 4V3l5 4L7 17']),
  keywords: 'bluetooth pairing devices headphones mouse keyboard',
  build() {
    const deviceHost = h('div');

    function renderDevices() {
      const enabled = settings.get('bluetooth.enabled') === true;
      const connected = settings.get('bluetooth.connected');

      if (!enabled) {
        deviceHost.replaceChildren(
          prefGroup(
            {},
            actionRow({
              title: 'Bluetooth is turned off',
              subtitle: 'Turn on Bluetooth to connect and pair devices',
              keywords: 'bluetooth off',
            }),
          ),
        );
        return;
      }

      const paired = BLUETOOTH_DEVICES.filter((d) => d.paired).map((device) =>
        actionRow({
          title: device.name,
          subtitle: connected === device.id ? `${device.type} · Connected` : `${device.type} · Not connected`,
          suffix: switchControl({
            value: connected === device.id,
            label: device.name,
            onChange: (v) => {
              settings.set('bluetooth.connected', v ? device.id : '');
              renderDevices();
              if (v) {
                notify.show({ app: 'Bluetooth', title: 'Device connected', body: `${device.name} is now connected.` });
              }
            },
          }),
          keywords: `bluetooth ${device.name}`,
        }),
      );

      const available = BLUETOOTH_DEVICES.filter((d) => !d.paired).map((device) =>
        actionRow({
          title: device.name,
          subtitle: device.type,
          suffix: button({
            label: 'Pair',
            onClick: () =>
              dialog.alert({
                title: `Pair with ${device.name}?`,
                body: 'Confirm the PIN 483920 is shown on the device, then accept the pairing request there.',
              }),
          }),
          keywords: `bluetooth pair ${device.name}`,
        }),
      );

      deviceHost.replaceChildren(
        prefGroup({ title: 'Devices' }, ...paired),
        prefGroup({ title: 'Available Devices' }, ...available),
      );
    }

    renderDevices();

    return prefPage(
      { title: 'Bluetooth' },
      prefGroup(
        {},
        switchRow({
          title: 'Bluetooth',
          subtitle: 'Intel AX201 Bluetooth 5.2',
          value: settings.get('bluetooth.enabled') === true,
          onChange: (v) => {
            settings.set('bluetooth.enabled', v);
            if (!v) settings.set('bluetooth.connected', '');
            renderDevices();
          },
          keywords: 'bluetooth enable turn on off',
        }),
      ),
      deviceHost,
      prefCard(
        {},
        h('p.adw-note', {
          text: `Visible as “${users.hostname}” while this panel is open.`,
        }),
      ),
    );
  },
};
