/**
 * js/apps/settings/sections-system.js — Sound, Power and Date & Time panels.
 */

import { h, svg } from '../../core/dom.js';
import { notify } from '../../core/notify.js';
import { settings } from './state.js';
import { prefPage, prefGroup, switchRow, comboRow, sliderRow, buttonRow, radioRows, actionRow } from './widgets.js';

const icon = (paths) => () => svg(paths, { size: 16, strokeWidth: 1.7 });

/* ------------------------------------------------------------------ *
 * Sound
 * ------------------------------------------------------------------ */

const OUTPUT_DEVICES = [
  'Speakers — Built-in Audio',
  'Headphones — Built-in Audio',
  'HDMI / DisplayPort — Built-in Audio',
];

const INPUT_DEVICES = ['Internal Microphone — Built-in Audio', 'Headset Microphone — Built-in Audio'];

const ALERT_SOUNDS = ['Bark', 'Drip', 'Glass', 'Sonar'];

export const soundSection = {
  id: 'sound',
  title: 'Sound',
  icon: icon(['M11 5L6 9H3v6h3l5 4z', 'M16 9a4 4 0 0 1 0 6', 'M19 6a8 8 0 0 1 0 12']),
  keywords: 'sound volume audio output input microphone alert speakers',
  build() {
    const maxVolume = settings.get('sound.overAmplification') ? 150 : 100;

    const volumeRow = sliderRow({
      title: 'Output Volume',
      value: Math.min(Number(settings.get('sound.outputVolume')), maxVolume),
      min: 0,
      max: maxVolume,
      step: 1,
      format: (v) => `${v}%`,
      onChange: (v) => settings.set('sound.outputVolume', v),
      keywords: 'volume output loudness',
    });

    return prefPage(
      { title: 'Sound' },
      prefGroup(
        { title: 'Output' },
        comboRow({
          title: 'Output Device',
          value: settings.get('sound.outputDevice'),
          options: OUTPUT_DEVICES,
          onChange: (v) => settings.set('sound.outputDevice', v),
          keywords: 'output device speakers headphones',
        }),
        volumeRow,
        switchRow({
          title: 'Mute',
          value: settings.get('sound.outputMuted') === true,
          onChange: (v) => settings.set('sound.outputMuted', v),
          keywords: 'mute silence output',
        }),
        switchRow({
          title: 'Over-Amplification',
          subtitle: 'Allows raising the volume above 100%. This can result in a loss of audio quality.',
          value: settings.get('sound.overAmplification') === true,
          onChange: (v) => {
            settings.set('sound.overAmplification', v);
            const slider = volumeRow.querySelector('.adw-slider');
            if (slider instanceof HTMLInputElement) {
              slider.max = v ? '150' : '100';
              if (!v && Number(slider.value) > 100) {
                slider.value = '100';
                settings.set('sound.outputVolume', 100);
                const readout = volumeRow.querySelector('.adw-slider__value');
                if (readout) readout.textContent = '100%';
              }
            }
          },
          keywords: 'over amplification loud boost',
        }),
        sliderRow({
          title: 'Balance',
          value: Number(settings.get('sound.balance')),
          min: -100,
          max: 100,
          step: 5,
          format: (v) => (v === 0 ? 'Centre' : v < 0 ? `Left ${Math.abs(v)}%` : `Right ${v}%`),
          onChange: (v) => settings.set('sound.balance', v),
          keywords: 'balance left right stereo',
        }),
        buttonRow({
          title: 'Test',
          subtitle: 'Play a test tone through each speaker',
          label: 'Test',
          onClick: () =>
            notify.show({
              app: 'Settings',
              title: 'Speaker test',
              body: `Front Left and Front Right tested on ${settings.get('sound.outputDevice')}`,
            }),
          keywords: 'test speakers tone',
        }),
      ),
      prefGroup(
        { title: 'Input' },
        comboRow({
          title: 'Input Device',
          value: settings.get('sound.inputDevice'),
          options: INPUT_DEVICES,
          onChange: (v) => settings.set('sound.inputDevice', v),
          keywords: 'input microphone device',
        }),
        sliderRow({
          title: 'Input Volume',
          value: Number(settings.get('sound.inputVolume')),
          min: 0,
          max: 100,
          step: 1,
          format: (v) => `${v}%`,
          onChange: (v) => settings.set('sound.inputVolume', v),
          keywords: 'microphone input volume',
        }),
        switchRow({
          title: 'Mute Microphone',
          value: settings.get('sound.inputMuted') === true,
          onChange: (v) => settings.set('sound.inputMuted', v),
          keywords: 'mute microphone input',
        }),
      ),
      prefGroup(
        { title: 'Sounds' },
        comboRow({
          title: 'Alert Sound',
          value: settings.get('sound.alertSound'),
          options: ALERT_SOUNDS,
          onChange: (v) => settings.set('sound.alertSound', v),
          keywords: 'alert sound bell',
        }),
        switchRow({
          title: 'System Sounds',
          subtitle: 'Play a sound for window and button events',
          value: settings.get('sound.systemSounds') === true,
          onChange: (v) => settings.set('sound.systemSounds', v),
          keywords: 'system sounds events',
        }),
      ),
    );
  },
};

/* ------------------------------------------------------------------ *
 * Power
 * ------------------------------------------------------------------ */

const DELAYS = [
  { value: 60, label: '1 minute' },
  { value: 120, label: '2 minutes' },
  { value: 300, label: '5 minutes' },
  { value: 600, label: '10 minutes' },
  { value: 900, label: '15 minutes' },
  { value: 1200, label: '20 minutes' },
  { value: 1800, label: '30 minutes' },
  { value: 3600, label: '1 hour' },
  { value: 0, label: 'Never' },
];

export const powerSection = {
  id: 'power',
  title: 'Power',
  icon: icon(['M12 3v9', 'M7.5 6.3a7.5 7.5 0 1 0 9 0']),
  keywords: 'power battery suspend performance saver dim blank screen',
  build() {
    const batteryLevel = 87;

    const batteryRow = actionRow({
      title: 'Battery',
      subtitle: '2 hours 41 minutes until fully charged',
      class: 'adw-row--battery',
      suffix: h(
        'div.battery-gauge',
        {},
        h('span.battery-gauge__track', {}, h('span.battery-gauge__fill', { style: { width: `${batteryLevel}%` } })),
        h('span.battery-gauge__value', { text: `${batteryLevel}%` }),
      ),
      keywords: 'battery charge level',
    });

    return prefPage(
      { title: 'Power' },
      prefGroup({}, batteryRow),
      prefGroup(
        { title: 'Power Mode' },
        ...radioRows({
          value: settings.get('power.mode'),
          onChange: (v) => settings.set('power.mode', v),
          keywords: 'power mode performance balanced saver',
          options: [
            { value: 'performance', title: 'Performance', subtitle: 'High performance and power usage' },
            { value: 'balanced', title: 'Balanced Power', subtitle: 'Standard performance and power usage' },
            { value: 'saver', title: 'Power Saver', subtitle: 'Reduced performance and power usage' },
          ],
        }),
      ),
      prefGroup(
        { title: 'Power Saving' },
        switchRow({
          title: 'Dim Screen',
          subtitle: 'Reduces the screen brightness when the computer is inactive',
          value: settings.get('power.dimScreen') === true,
          onChange: (v) => settings.set('power.dimScreen', v),
          keywords: 'dim screen brightness inactive',
        }),
        comboRow({
          title: 'Screen Blank',
          subtitle: 'Turns the screen off after a period of inactivity',
          value: String(settings.get('power.blankDelay')),
          options: DELAYS.map((d) => ({ value: String(d.value), label: d.label })),
          onChange: (v) => settings.set('power.blankDelay', Number(v)),
          keywords: 'screen blank timeout',
        }),
        switchRow({
          title: 'Automatic Suspend',
          value: settings.get('power.automaticSuspend') === true,
          onChange: (v) => settings.set('power.automaticSuspend', v),
          keywords: 'automatic suspend sleep',
        }),
        comboRow({
          title: 'Delay',
          subtitle: 'Time before the computer suspends on battery power',
          value: String(settings.get('power.suspendDelay')),
          options: DELAYS.filter((d) => d.value !== 0).map((d) => ({ value: String(d.value), label: d.label })),
          onChange: (v) => settings.set('power.suspendDelay', Number(v)),
          keywords: 'suspend delay timeout',
        }),
        switchRow({
          title: 'Automatic Power Saver',
          subtitle: 'Enables power saver mode when battery power is low',
          value: settings.get('power.automaticPowerSaver') === true,
          onChange: (v) => settings.set('power.automaticPowerSaver', v),
          keywords: 'automatic power saver low battery',
        }),
      ),
      prefGroup(
        { title: 'General' },
        switchRow({
          title: 'Show Battery Percentage',
          subtitle: 'Shows the exact charge level in the top bar',
          value: settings.get('power.batteryPercentage') === true,
          onChange: (v) => settings.set('power.batteryPercentage', v),
          keywords: 'battery percentage top bar',
        }),
      ),
    );
  },
};

/* ------------------------------------------------------------------ *
 * Date & Time
 * ------------------------------------------------------------------ */

const TIMEZONES = [
  'Europe/London',
  'Europe/Dublin',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Africa/Lagos',
  'Asia/Seoul',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Kolkata',
  'Australia/Sydney',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'UTC',
];

export const dateTimeSection = {
  id: 'datetime',
  title: 'Date & Time',
  icon: icon(['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7v5l3.5 2']),
  keywords: 'date time clock timezone ntp format seconds week numbers',
  build() {
    const clockValue = h('span.adw-row__value.is-selectable', { text: '' });

    function formatNow() {
      const now = new Date();
      const timezone = settings.get('datetime.timezone');
      const hour12 = settings.get('datetime.timeFormat') === '12h';
      const options = {
        weekday: settings.get('datetime.showWeekday') ? 'long' : undefined,
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: settings.get('datetime.showSeconds') ? '2-digit' : undefined,
        hour12,
      };
      if (timezone !== 'local') options.timeZone = timezone;
      try {
        return new Intl.DateTimeFormat('en-GB', options).format(now);
      } catch {
        return now.toString();
      }
    }

    const timeRow = actionRow({
      title: 'Date & Time',
      subtitle: 'Synchronised with an NTP server while automatic time is on',
      suffix: clockValue,
      keywords: 'date time clock now',
    });

    clockValue.textContent = formatNow();
    const timer = window.setInterval(() => {
      if (!clockValue.isConnected) {
        window.clearInterval(timer);
        return;
      }
      clockValue.textContent = formatNow();
    }, 1000);

    return prefPage(
      { title: 'Date & Time' },
      prefGroup(
        {},
        switchRow({
          title: 'Automatic Date & Time',
          subtitle: 'Requires internet access',
          value: settings.get('datetime.automatic') === true,
          onChange: (v) => settings.set('datetime.automatic', v),
          keywords: 'automatic date time ntp',
        }),
        switchRow({
          title: 'Automatic Time Zone',
          subtitle: 'Requires location services',
          value: settings.get('datetime.automaticTimezone') === true,
          onChange: (v) => settings.set('datetime.automaticTimezone', v),
          keywords: 'automatic timezone location',
        }),
        timeRow,
        comboRow({
          title: 'Time Zone',
          value: settings.get('datetime.timezone'),
          options: TIMEZONES,
          onChange: (v) => {
            settings.set('datetime.timezone', v);
            clockValue.textContent = formatNow();
          },
          keywords: 'time zone region',
        }),
      ),
      prefGroup(
        { title: 'Clock & Calendar' },
        comboRow({
          title: 'Time Format',
          value: settings.get('datetime.timeFormat'),
          options: [
            { value: '24h', label: '24-hour' },
            { value: '12h', label: 'AM / PM' },
          ],
          onChange: (v) => {
            settings.set('datetime.timeFormat', v);
            clockValue.textContent = formatNow();
          },
          keywords: 'time format 24 hour am pm',
        }),
        switchRow({
          title: 'Week Day',
          value: settings.get('datetime.showWeekday') === true,
          onChange: (v) => {
            settings.set('datetime.showWeekday', v);
            clockValue.textContent = formatNow();
          },
          keywords: 'clock weekday',
        }),
        switchRow({
          title: 'Date',
          value: settings.get('datetime.showDate') === true,
          onChange: (v) => settings.set('datetime.showDate', v),
          keywords: 'clock date top bar',
        }),
        switchRow({
          title: 'Seconds',
          value: settings.get('datetime.showSeconds') === true,
          onChange: (v) => {
            settings.set('datetime.showSeconds', v);
            clockValue.textContent = formatNow();
          },
          keywords: 'clock seconds',
        }),
        switchRow({
          title: 'Week Numbers',
          subtitle: 'Shows the week number in the calendar popover',
          value: settings.get('datetime.weekNumbers') === true,
          onChange: (v) => settings.set('datetime.weekNumbers', v),
          keywords: 'calendar week numbers',
        }),
      ),
    );
  },
};
