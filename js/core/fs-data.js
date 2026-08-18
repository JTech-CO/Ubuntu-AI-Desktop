/**
 * js/core/fs-data.js — verbatim system file contents for the default tree.
 *
 * Everything here is the genuine text shipped by Ubuntu 24.04.1 LTS
 * (Noble Numbat) so that `cat /etc/os-release`, `cat ~/.bashrc`,
 * `lsb_release -a` and friends print exactly what a real box prints.
 *
 * The one exception is `cpuinfo()`, which describes the machine the browser is
 * actually running on rather than a made-up laptop — see `js/core/device.js`.
 *
 * Sibling of js/core/fs.js — see ARCHITECTURE §6.
 */

import { device } from './device.js';

export const OS_RELEASE = `PRETTY_NAME="Ubuntu 24.04.1 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION="24.04.1 LTS (Noble Numbat)"
VERSION_CODENAME=noble
ID=ubuntu
ID_LIKE=debian
HOME_URL="https://www.ubuntu.com/"
SUPPORT_URL="https://help.ubuntu.com/"
BUG_REPORT_URL="https://bugs.launchpad.net/ubuntu/"
PRIVACY_POLICY_URL="https://www.ubuntu.com/legal/terms-and-policies/privacy-policy"
UBUNTU_CODENAME=noble
LOGO=ubuntu-logo
`;

export const LSB_RELEASE = `DISTRIB_ID=Ubuntu
DISTRIB_RELEASE=24.04
DISTRIB_CODENAME=noble
DISTRIB_DESCRIPTION="Ubuntu 24.04.1 LTS"
`;

export const HOSTNAME_FILE = `ubuntu-ai
`;

export const HOSTS = `127.0.0.1\tlocalhost
127.0.1.1\tubuntu-ai

# The following lines are desirable for IPv6 capable hosts
::1     ip6-localhost ip6-loopback
fe00::0 ip6-localnet
ff00::0 ip6-mcastprefix
ff02::1 ip6-allnodes
ff02::2 ip6-allrouters
`;

export const SHELLS = `# /etc/shells: valid login shells
/bin/sh
/usr/bin/sh
/bin/bash
/usr/bin/bash
/bin/rbash
/usr/bin/rbash
/bin/dash
/usr/bin/dash
`;

export const FSTAB = `# /etc/fstab: static file system information.
#
# Use 'blkid' to print the universally unique identifier for a
# device; this may be used with UUID= as a more robust way to name devices
# that works even if disks are added and removed. See fstab(5).
#
# <file system> <mount point>   <type>  <options>       <dump>  <pass>
# / was on /dev/sda2 during curtin installation
/dev/disk/by-uuid/8c2f19f4-6c2e-4d51-9a1f-0d3b7c5e41a2 / ext4 defaults 0 1
# /boot/efi was on /dev/sda1 during curtin installation
/dev/disk/by-uuid/B4E3-1A77 /boot/efi vfat defaults 0 1
/swap.img\tnone\tswap\tsw\t0\t0
`;

export const RESOLV_CONF = `# This is /run/systemd/resolve/stub-resolv.conf managed by man:systemd-resolved(8).
# Do not edit.
#
# This file might be symlinked as /etc/resolv.conf. If you're looking at
# /etc/resolv.conf and seeing this text, you have followed the symlink.
#
# This is a dynamic resolv.conf file for connecting local clients to the
# internal DNS stub resolver of systemd-resolved. This file lists all
# configured search domains.
#
# Run "resolvectl status" to see details about the uplink DNS servers
# currently in use.
#
# Third party programs should typically not access this file directly, but only
# through the symlink at /etc/resolv.conf. To manage man:resolv.conf(5) in a
# different way, replace this symlink by a static file or a different symlink.
#
# See man:systemd-resolved.service(8) for details about the supported modes of
# operation for /etc/resolv.conf.

nameserver 127.0.0.53
options edns0 trust-ad
search .
`;

export const ISSUE = `Ubuntu 24.04.1 LTS \\n \\l

`;

export const ISSUE_NET = `Ubuntu 24.04.1 LTS
`;

export const DEBIAN_VERSION = `trixie/sid
`;

export const MACHINE_ID = `5b7e0d1c9a4f42d3b1e6c8a70f2d3e91
`;

export const TIMEZONE = `Etc/UTC
`;

export const ENVIRONMENT_FILE = `PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin"
`;

export const SOURCES_LIST = `# Ubuntu sources have moved to /etc/apt/sources.list.d/ubuntu.sources
`;

export const UBUNTU_SOURCES = `Types: deb
URIs: http://archive.ubuntu.com/ubuntu/
Suites: noble noble-updates noble-backports
Components: main universe restricted multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: http://security.ubuntu.com/ubuntu/
Suites: noble-security
Components: main universe restricted multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
`;

/* ------------------------------------------------------------------ *
 * Home directory dotfiles — /etc/skel as shipped by the `bash` package
 * ------------------------------------------------------------------ */

export const BASHRC = `# ~/.bashrc: executed by bash(1) for non-login shells.
# see /usr/share/doc/bash/examples/startup-files (in the package bash-doc)
# for examples

# If not running interactively, don't do anything
case $- in
    *i*) ;;
      *) return;;
esac

# don't put duplicate lines or lines starting with space in the history.
# See bash(1) for more options
HISTCONTROL=ignoreboth

# append to the history file, don't overwrite it
shopt -s histappend

# for setting history length see HISTSIZE and HISTFILESIZE in bash(1)
HISTSIZE=1000
HISTFILESIZE=2000

# check the window size after each command and, if necessary,
# update the values of LINES and COLUMNS.
shopt -s checkwinsize

# If set, the pattern "**" used in a pathname expansion context will
# match all files and zero or more directories and subdirectories.
#shopt -s globstar

# make less more friendly for non-text input files, see lesspipe(1)
[ -x /usr/bin/lesspipe ] && eval "\$(SHELL=/bin/sh lesspipe)"

# set variable identifying the chroot you work in (used in the prompt below)
if [ -z "\${debian_chroot:-}" ] && [ -r /etc/debian_chroot ]; then
    debian_chroot=\$(cat /etc/debian_chroot)
fi

# set a fancy prompt (non-color, unless we know we "want" color)
case "\$TERM" in
    xterm-color|*-256color) color_prompt=yes;;
esac

# uncomment for a colored prompt, if the terminal has the capability; turned
# off by default to not distract the user: the focus in a terminal window
# should be on the output of commands, not on the prompt
#force_color_prompt=yes

if [ -n "\$force_color_prompt" ]; then
    if [ -x /usr/bin/tput ] && tput setaf 1 >&/dev/null; then
\t# We have color support; assume it's compliant with Ecma-48
\t# (ISO/IEC-6429). (Lack of such support is extremely rare, and such
\t# a case would tend to support setf rather than setaf.)
\tcolor_prompt=yes
    else
\tcolor_prompt=
    fi
fi

if [ "\$color_prompt" = yes ]; then
    PS1='\${debian_chroot:+(\$debian_chroot)}\\[\\033[01;32m\\]\\u@\\h\\[\\033[00m\\]:\\[\\033[01;34m\\]\\w\\[\\033[00m\\]\\$ '
else
    PS1='\${debian_chroot:+(\$debian_chroot)}\\u@\\h:\\w\\$ '
fi
unset color_prompt force_color_prompt

# If this is an xterm set the title to user@host:dir
case "\$TERM" in
xterm*|rxvt*)
    PS1="\\[\\e]0;\${debian_chroot:+(\$debian_chroot)}\\u@\\h: \\w\\a\\]\$PS1"
    ;;
*)
    ;;
esac

# enable color support of ls and also add handy aliases
if [ -x /usr/bin/dircolors ]; then
    test -r ~/.dircolors && eval "\$(dircolors -b ~/.dircolors)" || eval "\$(dircolors -b)"
    alias ls='ls --color=auto'
    #alias dir='dir --color=auto'
    #alias vdir='vdir --color=auto'

    alias grep='grep --color=auto'
    alias fgrep='fgrep --color=auto'
    alias egrep='egrep --color=auto'
fi

# colored GCC warnings and errors
#export GCC_COLORS='error=01;31:warning=01;35:note=01;36:caret=01;32:locus=01:quote=01'

# some more ls aliases
alias ll='ls -alF'
alias la='ls -A'
alias l='ls -CF'

# Add an "alert" alias for long running commands.  Use like so:
#   sleep 10; alert
alias alert='notify-send --urgency=low -i "\$([ \$? = 0 ] && echo terminal || echo error)" "\$(history|tail -n1|sed -e '\\''s/^\\s*[0-9]\\+\\s*//;s/[;&|]\\s*alert\$//'\\'')"'

# Alias definitions.
# You may want to put all your additions into a separate file like
# ~/.bash_aliases, instead of adding them here directly.
# See /usr/share/doc/bash-doc/examples in the bash-doc package.

if [ -f ~/.bash_aliases ]; then
    . ~/.bash_aliases
fi

# enable programmable completion features (you don't need to enable
# this, if it's already enabled in /etc/bash.bashrc and /etc/profile
# sources /etc/bash.bashrc).
if ! shopt -oq posix; then
  if [ -f /usr/share/bash-completion/bash_completion ]; then
    . /usr/share/bash-completion/bash_completion
  elif [ -f /etc/bash_completion ]; then
    . /etc/bash_completion
  fi
fi
`;

export const PROFILE = `# ~/.profile: executed by the command interpreter for login shells.
# This file is not read by bash(1), if ~/.bash_profile or ~/.bash_login
# exists.
# see /usr/share/doc/bash/examples/startup-files for examples.
# the files are located in the bash-doc package.

# the default umask is set in /etc/profile; for setting the umask
# for ssh logins, install and configure the libpam-umask package.
#umask 022

# if running bash
if [ -n "\$BASH_VERSION" ]; then
    # include .bashrc if it exists
    if [ -f "\$HOME/.bashrc" ]; then
\t. "\$HOME/.bashrc"
    fi
fi

# set PATH so it includes user's private bin if it exists
if [ -d "\$HOME/bin" ] ; then
    PATH="\$HOME/bin:\$PATH"
fi

# set PATH so it includes user's private bin if it exists
if [ -d "\$HOME/.local/bin" ] ; then
    PATH="\$HOME/.local/bin:\$PATH"
fi
`;

export const BASH_LOGOUT = `# ~/.bash_logout: executed by bash(1) when login shell exits.

# when leaving the console clear the screen to increase privacy

if [ "\$SHLVL" = 1 ]; then
    [ -x /usr/bin/clear_console ] && /usr/bin/clear_console -q
fi
`;

export const BASH_HISTORY = `sudo apt update
sudo apt upgrade -y
lsb_release -a
uname -a
df -h
free -h
cd ~/Projects
ls -la
python3 hello.py
git status
neofetch
`;

/* ------------------------------------------------------------------ *
 * /proc — static portions. The live values are generated in fs-tree.js
 * ------------------------------------------------------------------ */

export const PROC_VERSION = `Linux version 6.8.0-45-generic (buildd@lcy02-amd64-036) (x86_64-linux-gnu-gcc-13 (Ubuntu 13.2.0-23ubuntu4) 13.2.0, GNU ld (GNU Binutils for Ubuntu) 2.42) #45-Ubuntu SMP PREEMPT_DYNAMIC Fri Aug 30 12:02:04 UTC 2024
`;

export const KERNEL_RELEASE = '6.8.0-45-generic';
export const KERNEL_VERSION = '#45-Ubuntu SMP PREEMPT_DYNAMIC Fri Aug 30 12:02:04 UTC 2024';

/**
 * The `model name` field of one `/proc/cpuinfo` block.
 *
 * Web content is never told the real CPU model string, so this names the
 * instruction set and nothing more — deliberately *not* an Intel or AMD
 * marketing name, which would be a claim about hardware nobody here can see.
 * It stays ASCII and per-core, the way the real file is; `lscpu` and the About
 * page use `device.cpuModel()`, which adds the logical CPU count.
 *
 * @param {string} arch
 * @returns {string}
 */
function modelNameFor(arch) {
  if (arch === 'aarch64') return 'ARM64 processor (model not reported to the browser)';
  if (arch === 'i686') return 'x86 processor (model not reported to the browser)';
  return 'x86-64 processor (model not reported to the browser)';
}

/**
 * The x86-64-v3 baseline. Every flag here is implied by the `x86_64`
 * architecture itself; nothing model-specific (AVX-512, Intel PT, the
 * vendor-specific mitigations) is claimed, because none of it is knowable.
 */
const X86_FLAGS =
  'fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ' +
  'ss ht syscall nx pdpe1gb rdtscp lm constant_tsc rep_good nopl xtopology nonstop_tsc cpuid pni ' +
  'pclmulqdq monitor ssse3 fma cx16 pcid sse4_1 sse4_2 x2apic movbe popcnt tsc_deadline_timer aes ' +
  'xsave avx f16c rdrand hypervisor lahf_lm abm 3dnowprefetch fsgsbase tsc_adjust bmi1 avx2 smep ' +
  'bmi2 erms invpcid rdseed adx smap clflushopt xsaveopt xsavec xgetbv1 xsaves arat';

/** The equivalent baseline for a 32-bit x86 build. */
const I686_FLAGS =
  'fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ' +
  'ss ht nopl cpuid pni pclmulqdq monitor ssse3 cx16 sse4_1 sse4_2 movbe popcnt aes xsave avx ' +
  'hypervisor lahf_lm';

/** ARMv8-A baseline features, the aarch64 equivalent of the list above. */
const ARM_FEATURES =
  'fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp cpuid asimdrdm lrcpc dcpop asimddp';

/**
 * Build `/proc/cpuinfo` for the host machine.
 *
 * The processor count and the architecture are real. Everything else is
 * deliberately generic: the browser withholds the vendor, the model, the
 * stepping and the clock, so this prints an architecture baseline rather than
 * pretending to have read a specific part number off the die. The clock jitters
 * per call the way it does on real hardware under a scaling governor.
 *
 * One logical CPU is reported per core (`cpu cores` == `siblings`). The SMT
 * topology is not exposed to web content either, and claiming two threads per
 * core would be a guess — `lscpu` reports the same shape, so the two agree.
 *
 * @param {number} [cores] logical CPUs
 * @param {string} [arch] 'x86_64' | 'aarch64' | 'i686'
 * @returns {string}
 */
export function cpuinfo(cores = device.cores(), arch = device.arch()) {
  const count = Math.max(1, Math.round(cores) || 1);
  const model = modelNameFor(arch);
  const blocks = [];

  for (let i = 0; i < count; i += 1) {
    if (arch === 'aarch64') {
      // aarch64 uses an entirely different field set — no model name, no MHz.
      blocks.push(
        [
          `processor\t: ${i}`,
          `BogoMIPS\t: ${(48 + Math.random() * 0.4).toFixed(2)}`,
          `Features\t: ${ARM_FEATURES}`,
          'CPU implementer\t: 0x41',
          'CPU architecture: 8',
          'CPU variant\t: 0x0',
          'CPU part\t: 0x000',
          'CPU revision\t: 0',
        ].join('\n'),
      );
      continue;
    }

    const mhz = (1200 + Math.random() * 1700).toFixed(3);
    const bits32 = arch === 'i686';
    blocks.push(
      [
        `processor\t: ${i}`,
        'vendor_id\t: Unknown',
        'cpu family\t: 6',
        'model\t\t: 0',
        `model name\t: ${model}`,
        'stepping\t: 0',
        'microcode\t: 0x0',
        `cpu MHz\t\t: ${mhz}`,
        'cache size\t: 8192 KB',
        'physical id\t: 0',
        `siblings\t: ${count}`,
        `core id\t\t: ${i}`,
        `cpu cores\t: ${count}`,
        `apicid\t\t: ${i}`,
        `initial apicid\t: ${i}`,
        'fpu\t\t: yes',
        'fpu_exception\t: yes',
        'cpuid level\t: 16',
        'wp\t\t: yes',
        `flags\t\t: ${bits32 ? I686_FLAGS : X86_FLAGS}`,
        'bugs\t\t:',
        `bogomips\t: ${(4800 + Math.random() * 40).toFixed(2)}`,
        'clflush size\t: 64',
        'cache_alignment\t: 64',
        `address sizes\t: ${bits32 ? '36 bits physical, 32 bits virtual' : '39 bits physical, 48 bits virtual'}`,
        'power management:',
      ].join('\n'),
    );
  }
  return `${blocks.join('\n\n')}\n\n`;
}

/* ------------------------------------------------------------------ *
 * /usr/bin — the executables the terminal and `which` should find
 * ------------------------------------------------------------------ */

export const USR_BIN = [
  'apt', 'apt-cache', 'apt-config', 'apt-get', 'apt-key', 'apt-mark', 'arch', 'awk',
  'b2sum', 'base32', 'base64', 'basename', 'bash', 'bc', 'bunzip2', 'bzip2',
  'cal', 'cat', 'chgrp', 'chmod', 'chown', 'chroot', 'cksum', 'clear', 'cmp', 'comm',
  'cp', 'cowsay', 'csplit', 'curl', 'cut', 'dash', 'date', 'dd', 'df', 'diff', 'dig',
  'dircolors', 'dirname', 'dmesg', 'dpkg', 'dpkg-deb', 'dpkg-query', 'du', 'echo',
  'ed', 'egrep', 'env', 'expand', 'expr', 'factor', 'false', 'fastfetch', 'fgrep',
  'figlet', 'file', 'find', 'fmt', 'fold', 'fortune', 'free', 'gawk', 'gcc', 'gedit',
  'git', 'gpg', 'grep', 'groups', 'gunzip', 'gzip', 'head', 'hostid', 'hostname',
  'hostnamectl', 'id', 'install', 'ip', 'join', 'journalctl', 'kill', 'killall',
  'less', 'link', 'ln', 'locale', 'localectl', 'logname', 'ls', 'lsblk', 'lscpu',
  'lsb_release', 'lsof', 'lsusb', 'man', 'md5sum', 'mkdir', 'mkfifo', 'mktemp',
  'more', 'mv', 'nano', 'neofetch', 'netstat', 'nice', 'nl', 'nohup', 'nproc',
  'nslookup', 'numfmt', 'od', 'paste', 'perl', 'pgrep', 'pidof', 'ping', 'pkill',
  'pr', 'printenv', 'printf', 'ps', 'pwd', 'python3', 'readlink', 'realpath',
  'rev', 'rm', 'rmdir', 'runcon', 'sed', 'seq', 'sha1sum', 'sha256sum', 'sha512sum',
  'shred', 'shuf', 'sleep', 'snap', 'sort', 'split', 'ss', 'stat', 'stdbuf', 'strings',
  'stty', 'sudo', 'sum', 'sync', 'systemctl', 'tac', 'tail', 'tar', 'tee', 'test',
  'timeout', 'top', 'touch', 'tput', 'tr', 'traceroute', 'true', 'truncate', 'tty',
  'uname', 'unexpand', 'uniq', 'unlink', 'unzip', 'uptime', 'users', 'vim', 'wall',
  'watch', 'wc', 'wget', 'whereis', 'which', 'who', 'whoami', 'xargs', 'xdg-open',
  'yes', 'zip',
];

export const USR_SBIN = [
  'adduser', 'blkid', 'chpasswd', 'cron', 'dhclient', 'fdisk', 'groupadd', 'grpck',
  'ifconfig', 'iptables', 'ldconfig', 'logrotate', 'mkfs', 'mkfs.ext4', 'nologin',
  'ntpdate', 'reboot', 'route', 'service', 'shutdown', 'sshd', 'swapon', 'sysctl',
  'update-alternatives', 'update-grub', 'useradd', 'userdel', 'usermod', 'visudo',
];

/** Size reported for the Downloads ISO — the real 24.04.1 desktop image. */
export const ISO_SIZE = 6114770944;
