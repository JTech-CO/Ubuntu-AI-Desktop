/**
 * js/apps/terminal/commands/pkg-db.js — simulated APT/dpkg/snap package database.
 *
 * Seeded with what a stock Ubuntu 24.04.1 LTS desktop install carries, plus a
 * long tail of packages a user is likely to reach for. State (installed set,
 * pinned versions, last `apt update`) is persisted through `store` so an
 * install survives a reload, exactly like a real dpkg status database.
 */

import { store } from '../../../core/store.js';

const STORE_KEY = 'pkgdb';
const SNAP_KEY = 'snapdb';

/**
 * Static catalogue. Columns:
 *   name, version, section, downloadKB, installedKB, description,
 *   depends (space separated), flags, binaries (space separated)
 *
 * flags: `i` = installed on a default desktop, `a` = automatically installed,
 *        `u` = an upgrade is pending in noble-updates.
 * @type {Array<[string,string,string,number,number,string,string,string,string]>}
 */
const CATALOGUE = [
  ['accountsservice', '23.13.9-2ubuntu6', 'gnome', 68, 265, 'query and manipulate user account information', 'libaccountsservice0 libglib2.0-0', 'ia', ''],
  ['adduser', '3.137ubuntu1', 'admin', 101, 624, 'add and remove users and groups', 'passwd', 'ia', 'adduser deluser addgroup delgroup'],
  ['apparmor', '4.0.1really4.0.1-0ubuntu0.24.04.4', 'admin', 620, 2311, 'user-space parser utility for AppArmor', 'debconf libc6', 'ia', 'aa-status aa-enabled'],
  ['apt', '2.7.14build2', 'admin', 1376, 4224, 'commandline package manager', 'libapt-pkg6.0t64 libc6 libgcc-s1', 'i', 'apt apt-cache apt-cdrom apt-config apt-get apt-key apt-mark'],
  ['apt-utils', '2.7.14build2', 'admin', 211, 630, 'package management related utility programs', 'apt libapt-pkg6.0t64', 'ia', 'apt-extracttemplates apt-ftparchive apt-sortpkgs'],
  ['base-files', '13ubuntu10.1', 'admin', 73, 391, 'Debian base system miscellaneous files', '', 'i', ''],
  ['base-passwd', '3.6.3build1', 'admin', 48, 234, 'Debian base system master password and group files', 'libc6 libdebconfclient0', 'ia', 'update-passwd'],
  ['bash', '5.2.21-2ubuntu4', 'shells', 856, 1874, 'GNU Bourne Again SHell', 'base-files debianutils', 'i', 'bash bashbug'],
  ['bash-completion', '1:2.11-8', 'shells', 214, 1568, 'programmable completion for the bash shell', 'bash', 'i', ''],
  ['bc', '1.07.1-3ubuntu4', 'math', 88, 253, 'GNU bc arbitrary precision calculator language', 'libc6 libreadline8t64', '', 'bc'],
  ['binutils', '2.42-4ubuntu2.5', 'devel', 3412, 14208, 'GNU assembler, linker and binary utilities', 'binutils-common libbinutils', '', 'as ld ar nm objdump strip readelf'],
  ['bsdutils', '1:2.39.3-9ubuntu6.1', 'utils', 105, 302, 'basic utilities from 4.4BSD-Lite', 'libc6 libsystemd0', 'i', 'logger renice script wall'],
  ['build-essential', '12.10ubuntu1', 'devel', 5, 21, 'Informational list of build-essential packages', 'gcc g++ make libc6-dev dpkg-dev', '', ''],
  ['busybox-initramfs', '1:1.36.1-6ubuntu3.1', 'shells', 199, 493, 'Standalone shell setup for initramfs', 'libc6', 'ia', ''],
  ['bzip2', '1.0.8-5.1build0.1', 'utils', 35, 106, 'high-quality block-sorting file compressor', 'libbz2-1.0 libc6', 'i', 'bzip2 bunzip2 bzcat bzdiff bzgrep'],
  ['ca-certificates', '20240203', 'misc', 165, 400, 'Common CA certificates', 'openssl', 'i', 'update-ca-certificates'],
  ['coreutils', '9.4-3ubuntu6', 'utils', 1416, 7275, 'GNU core utilities', 'libacl1 libattr1 libc6 libgmp10 libselinux1', 'i', 'ls cp mv rm cat head tail sort uniq wc df du date echo'],
  ['cowsay', '3.03+dfsg2-8', 'games', 20, 90, 'configurable talking cow', 'perl', '', 'cowsay cowthink'],
  ['cpp', '4:13.2.0-7ubuntu1', 'interpreters', 5, 25, 'GNU C preprocessor (cpp)', 'cpp-13', '', 'cpp'],
  ['cron', '3.0pl1-184ubuntu2', 'admin', 74, 227, 'process scheduling daemon', 'libc6 libpam0g debianutils', 'i', 'crontab cron'],
  ['curl', '8.5.0-2ubuntu10.6', 'web', 227, 528, 'command line tool for transferring data with URL syntax', 'libcurl4t64 libc6 zlib1g', 'i', 'curl'],
  ['dash', '0.5.12-6ubuntu5', 'shells', 92, 226, 'POSIX-compliant shell', 'debianutils dpkg libc6', 'i', 'dash sh'],
  ['dbus', '1.14.10-4ubuntu4.1', 'admin', 24, 128, 'simple interprocess messaging system', 'dbus-bin dbus-daemon dbus-session-bus-common', 'i', 'dbus-send dbus-monitor'],
  ['debconf', '1.5.86ubuntu1', 'admin', 122, 570, 'Debian configuration management system', 'perl-base', 'ia', 'debconf dpkg-reconfigure'],
  ['debianutils', '5.17build1', 'utils', 89, 245, 'Miscellaneous utilities specific to Debian', 'libc6', 'i', 'run-parts savelog tempfile which'],
  ['diffutils', '1:3.10-1build1', 'utils', 218, 1476, 'File comparison utilities', 'libc6', 'i', 'diff diff3 sdiff cmp'],
  ['dpkg', '1.22.6ubuntu6.1', 'admin', 1287, 6584, 'Debian package management system', 'libbz2-1.0 libc6 liblzma5 libselinux1 tar zlib1g', 'i', 'dpkg dpkg-deb dpkg-divert dpkg-query dpkg-split dpkg-trigger'],
  ['dpkg-dev', '1.22.6ubuntu6.1', 'utils', 1264, 3384, 'Debian package development tools', 'dpkg perl make patch', '', 'dpkg-buildpackage dpkg-source dpkg-genchanges'],
  ['e2fsprogs', '1.47.0-2.4~exp1ubuntu4.1', 'admin', 583, 1621, 'ext2/ext3/ext4 file system utilities', 'libc6 libcom-err2 libext2fs2t64 libuuid1', 'i', 'mke2fs fsck.ext4 tune2fs resize2fs dumpe2fs'],
  ['file', '1:5.45-3build1', 'utils', 22, 105, 'Recognize the type of data in a file using magic numbers', 'libc6 libmagic1t64', 'i', 'file'],
  ['findutils', '4.9.0-5build1', 'utils', 335, 1908, 'utilities for finding files--find, xargs', 'libc6 libselinux1', 'i', 'find xargs'],
  ['firefox', '129.0+build2-0ubuntu0.24.04.1', 'web', 800, 2400, 'Transitional package - firefox -> firefox snap', 'snapd', 'i', 'firefox'],
  ['fonts-ubuntu', '0.869+git20240321-0ubuntu1', 'fonts', 2210, 4184, 'sans-serif font set from Ubuntu', '', 'ia', ''],
  ['fortune-mod', '1:1.99.1-7.1', 'games', 42, 148, 'provides fortune cookies on demand', 'librecode0 fortunes-min', '', 'fortune'],
  ['g++', '4:13.2.0-7ubuntu1', 'devel', 1, 15, 'GNU C++ compiler', 'gcc g++-13', '', 'g++'],
  ['gawk', '1:5.2.1-2build3', 'interpreters', 449, 1698, 'GNU awk, a pattern scanning and processing language', 'libc6 libmpfr6 libreadline8t64 libsigsegv2', '', 'gawk awk'],
  ['gcc', '4:13.2.0-7ubuntu1', 'devel', 5, 51, 'GNU C compiler', 'cpp gcc-13', '', 'gcc'],
  ['gcc-13', '13.2.0-23ubuntu4', 'devel', 20496, 63118, 'GNU C compiler', 'gcc-13-base libc6 libgcc-13-dev', '', 'gcc-13'],
  ['gdb', '15.0.50.20240403-0ubuntu1', 'devel', 3902, 11430, 'GNU Debugger', 'libc6 libgcc-s1 libreadline8t64 libpython3.12', '', 'gdb gcore gdbserver'],
  ['gedit', '46.2-1', 'gnome', 380, 1720, 'official text editor of the GNOME desktop environment', 'libgtk-3-0t64 libgedit-amtk-5-0', '', 'gedit'],
  ['gettext-base', '0.21-14ubuntu2', 'utils', 39, 219, 'GNU Internationalization utilities for the base system', 'libc6', 'ia', 'gettext envsubst'],
  ['ghostscript', '10.02.1~dfsg1-0ubuntu7.4', 'text', 42, 172, 'interpreter for the PostScript language and for PDF', 'libgs10 libc6', '', 'gs ps2pdf pdf2ps'],
  ['gimp', '2.10.36-3build1', 'graphics', 4204, 18344, 'GNU Image Manipulation Program', 'libgimp2.0 libgtk2.0-0t64 libbabl-0.1-0', '', 'gimp gimp-2.10'],
  ['git', '1:2.43.0-1ubuntu7.2', 'vcs', 3680, 19532, 'fast, scalable, distributed revision control system', 'libc6 libcurl3t64-gnutls libexpat1 libpcre2-8-0 zlib1g perl', '', 'git git-shell git-upload-pack git-receive-pack'],
  ['gnome-calculator', '1:46.0-1ubuntu1', 'gnome', 1512, 4088, 'GNOME desktop calculator', 'libgtk-4-1 libadwaita-1-0 libgcalc-2-0', 'i', 'gnome-calculator'],
  ['gnome-shell', '46.0-0ubuntu6~24.04.5', 'gnome', 2144, 9760, 'graphical shell for the GNOME desktop', 'gjs gnome-settings-daemon libmutter-14-0', 'i', 'gnome-shell gnome-extensions'],
  ['gnome-terminal', '3.52.0-1ubuntu2', 'gnome', 615, 2510, 'GNOME terminal emulator application', 'libvte-2.91-0 libgtk-3-0t64 dconf-gsettings-backend', 'i', 'gnome-terminal gnome-terminal.real'],
  ['gnome-text-editor', '46.2-1', 'gnome', 470, 1980, 'simple text editor for GNOME', 'libgtk-4-1 libadwaita-1-0 libgtksourceview-5-0', 'i', 'gnome-text-editor'],
  ['gnupg', '2.4.4-2ubuntu17.2', 'utils', 359, 508, 'GNU privacy guard - a free PGP replacement', 'gpg gpg-agent gpgconf dirmngr', 'i', 'gpg gpgv gpgconf'],
  ['grep', '3.11-4build1', 'utils', 191, 574, 'GNU grep, egrep and fgrep', 'libc6 libpcre2-8-0', 'i', 'grep egrep fgrep rgrep'],
  ['gzip', '1.12-1ubuntu3', 'utils', 96, 254, 'GNU compression utilities', 'libc6', 'i', 'gzip gunzip zcat zdiff zgrep zless'],
  ['hostname', '3.23+nmu2ubuntu2', 'admin', 11, 44, 'utility to set/show the host name or domain name', 'libc6', 'i', 'hostname dnsdomainname domainname'],
  ['htop', '3.3.0-4build1', 'utils', 165, 401, 'interactive processes viewer', 'libc6 libncursesw6 libnl-3-200 libtinfo6', '', 'htop'],
  ['imagemagick', '8:6.9.12.98+dfsg1-5.2build2', 'graphics', 87, 231, 'image manipulation programs', 'imagemagick-6.q16', '', 'convert identify mogrify montage'],
  ['init-system-helpers', '1.66ubuntu1', 'admin', 39, 132, 'helper tools for all init systems', 'perl-base', 'ia', 'invoke-rc.d service update-rc.d deb-systemd-helper'],
  ['iproute2', '6.1.0-1ubuntu6', 'net', 1120, 3554, 'networking and traffic control tools', 'libbpf1 libc6 libelf1t64 libmnl0 libxtables12', 'i', 'ip ss bridge tc rtacct'],
  ['iputils-ping', '3:20240117-1build1', 'net', 45, 130, 'Tools to test the reachability of network hosts', 'libcap2-bin libc6 libidn2-0', 'i', 'ping ping4 ping6'],
  ['jq', '1.7.1-3build1', 'utils', 76, 202, 'lightweight and flexible command-line JSON processor', 'libjq1 libc6', '', 'jq'],
  ['less', '590-2ubuntu2.1', 'text', 143, 353, 'pager program similar to more', 'libc6 libtinfo6 libpcre2-8-0', 'i', 'less lessecho lesskey lessfile lesspipe'],
  ['libc-bin', '2.39-0ubuntu8.3', 'libs', 671, 1471, 'GNU C Library: Binaries', '', 'i', 'ldd ldconfig getconf locale iconv'],
  ['libc6', '2.39-0ubuntu8.3', 'libs', 2896, 12690, 'GNU C Library: Shared libraries', 'libgcc-s1', 'i', ''],
  ['libcurl4t64', '8.5.0-2ubuntu10.6', 'libs', 341, 908, 'easy-to-use client-side URL transfer library', 'libc6 libnghttp2-14 libssl3t64 zlib1g', 'ia', ''],
  ['libgcc-s1', '14-20240412-0ubuntu1', 'libs', 64, 137, 'GCC support library', 'gcc-14-base libc6', 'i', ''],
  ['libglib2.0-0t64', '2.80.0-6ubuntu3.2', 'libs', 1544, 4302, 'GLib library of C routines', 'libc6 libffi8 libpcre2-8-0 zlib1g', 'ia', ''],
  ['libgtk-3-0t64', '3.24.41-4ubuntu1.2', 'libs', 2818, 7844, 'GTK graphical user interface library', 'libglib2.0-0t64 libcairo2 libpango-1.0-0', 'ia', ''],
  ['libgtk-4-1', '4.14.2+ds-1ubuntu1', 'libs', 3204, 9218, 'GTK graphical user interface library', 'libglib2.0-0t64 libgraphene-1.0-0 libvulkan1', 'ia', ''],
  ['libpam-modules', '1.5.3-5ubuntu5.1', 'admin', 288, 1029, 'Pluggable Authentication Modules for PAM', 'libc6 libaudit1 libpam0g libselinux1', 'ia', ''],
  ['libpython3.12', '3.12.3-1ubuntu0.3', 'libs', 1917, 5342, 'Shared Python runtime library (version 3.12)', 'libpython3.12-stdlib libc6', 'ia', ''],
  ['libselinux1', '3.5-2build1', 'libs', 79, 195, 'SELinux runtime shared libraries', 'libc6 libpcre2-8-0', 'i', ''],
  ['libssl3t64', '3.0.13-0ubuntu3.4', 'libs', 1934, 4712, 'Secure Sockets Layer toolkit - shared libraries', 'libc6', 'ia', ''],
  ['libsystemd0', '255.4-1ubuntu8.4', 'libs', 434, 1035, 'systemd utility library', 'libc6 libcap2 libgcrypt20 liblz4-1 libzstd1', 'i', ''],
  ['login', '1:4.13+dfsg1-4ubuntu3.2', 'admin', 202, 1274, 'system login tools', 'libaudit1 libc6 libpam0g', 'i', 'login su nologin sulogin'],
  ['logrotate', '3.21.0-2build1', 'admin', 56, 149, 'Log rotation utility', 'libc6 libpopt0 libselinux1 cron', 'i', 'logrotate'],
  ['lsb-release', '12.0-2', 'misc', 12, 43, 'Linux Standard Base version reporting utility', 'python3 distro-info-data', 'i', 'lsb_release'],
  ['make', '4.3-4.1build2', 'devel', 180, 1155, 'utility for directing compilation', 'libc6', '', 'make'],
  ['man-db', '2.12.0-4build2', 'doc', 1319, 3286, 'tools for reading manual pages', 'bsdextrautils groff-base libc6 libgdbm6t64 libpipeline1 zlib1g', 'i', 'man mandb apropos whatis manpath'],
  ['mount', '2.39.3-9ubuntu6.1', 'admin', 148, 419, 'tools for mounting and manipulating filesystems', 'libblkid1 libc6 libmount1 libselinux1', 'i', 'mount umount findmnt swapon swapoff'],
  ['nano', '7.2-2ubuntu0.1', 'editors', 280, 891, 'small, friendly text editor inspired by Pico', 'libc6 libncursesw6 libtinfo6', 'i', 'nano rnano'],
  ['ncurses-base', '6.4+20240113-1ubuntu2', 'misc', 22, 351, 'basic terminal type definitions', '', 'i', ''],
  ['ncurses-bin', '6.4+20240113-1ubuntu2', 'utils', 187, 561, 'terminal-related programs and man pages', 'libc6 libtinfo6', 'i', 'tput tset clear infocmp toe'],
  ['neofetch', '7.1.0-4', 'utils', 79, 351, 'Shows Linux System Information with Distribution Logo', 'bash', 'i', 'neofetch'],
  ['net-tools', '2.10-0.1ubuntu4', 'net', 204, 800, 'NET-3 networking toolkit', 'libc6', 'i', 'ifconfig netstat route arp rarp nameif'],
  ['netcat-openbsd', '1.226-1ubuntu2', 'net', 43, 111, 'TCP/IP swiss army knife', 'libbsd0 libc6', '', 'nc netcat'],
  ['nginx', '1.24.0-2ubuntu7.1', 'httpd', 42, 121, 'small, powerful, scalable web/proxy server', 'nginx-common libc6 libpcre2-8-0 libssl3t64', '', 'nginx'],
  ['nodejs', '18.19.1+dfsg-6ubuntu5', 'javascript', 322, 823, 'evented I/O for V8 javascript - runtime executable', 'libnode109 libc6 ca-certificates', '', 'node nodejs'],
  ['npm', '9.2.0~ds1-2', 'javascript', 1912, 9400, 'package manager for Node.js', 'nodejs node-abbrev node-cacache', '', 'npm npx'],
  ['openssh-client', '1:9.6p1-3ubuntu13.5', 'net', 906, 4614, 'secure shell (SSH) client, for secure access to remote machines', 'libc6 libedit2 libselinux1 libssl3t64 zlib1g', 'i', 'ssh scp sftp ssh-keygen ssh-add ssh-agent'],
  ['openssh-server', '1:9.6p1-3ubuntu13.5', 'net', 511, 1735, 'secure shell (SSH) server, for secure access from remote machines', 'openssh-client openssh-sftp-server libpam-runtime ucf', '', 'sshd'],
  ['openssl', '3.0.13-0ubuntu3.4', 'utils', 1188, 2436, 'Secure Sockets Layer toolkit - cryptographic utility', 'libc6 libssl3t64', 'i', 'openssl c_rehash'],
  ['passwd', '1:4.13+dfsg1-4ubuntu3.2', 'admin', 1034, 3268, 'change and administer password and group data', 'libaudit1 libc6 libpam0g libselinux1', 'i', 'passwd chsh chfn useradd userdel usermod groupadd'],
  ['perl', '5.38.2-3.2ubuntu0.1', 'perl', 231, 665, 'Larry Wall’s Practical Extraction and Report Language', 'perl-base perl-modules-5.38 libperl5.38t64', 'i', 'perl perl5.38.2'],
  ['perl-base', '5.38.2-3.2ubuntu0.1', 'perl', 1731, 7960, 'minimal Perl system', 'dpkg libc6 libcrypt1', 'i', 'perl-base'],
  ['procps', '2:4.0.4-4ubuntu3.2', 'admin', 706, 2143, '/proc file system utilities', 'libc6 libncursesw6 libproc2-0 libtinfo6', 'i', 'ps top free uptime kill pkill pgrep vmstat watch sysctl'],
  ['python3', '3.12.3-0ubuntu2', 'python', 23, 96, 'interactive high-level object-oriented language (default python3 version)', 'python3.12 python3-minimal', 'i', 'python3 pydoc3'],
  ['python3-pip', '24.0+dfsg-1ubuntu1.1', 'python', 1325, 6220, 'Python package installer', 'python3 python3-distutils python3-setuptools', '', 'pip pip3'],
  ['python3.12', '3.12.3-1ubuntu0.3', 'python', 651, 2464, 'Interactive high-level object-oriented language (version 3.12)', 'libpython3.12-stdlib python3.12-minimal', 'i', 'python3.12'],
  ['ripgrep', '14.1.0-1', 'utils', 1424, 4864, 'Recursively searches directories for a regex pattern', 'libc6 libgcc-s1', '', 'rg'],
  ['rsync', '3.2.7-1ubuntu1.2', 'net', 439, 1108, 'fast, versatile, remote (and local) file-copying tool', 'base-files libacl1 libc6 liblz4-1 libpopt0 libssl3t64 libzstd1', 'i', 'rsync'],
  ['sed', '4.9-2build1', 'utils', 189, 494, 'GNU stream editor for filtering/transforming text', 'libacl1 libc6 libselinux1', 'i', 'sed'],
  ['snapd', '2.63+24.04ubuntu0.1', 'utils', 24356, 108420, 'Daemon and tooling that enable snap packages', 'adduser ca-certificates libc6 openssh-client squashfs-tools systemd', 'i', 'snap snapctl'],
  ['sudo', '1.9.15p5-3ubuntu5', 'admin', 985, 3082, 'Provide limited super user privileges to specific users', 'libaudit1 libc6 libpam0g libselinux1', 'i', 'sudo sudoedit sudoreplay'],
  ['systemd', '255.4-1ubuntu8.4', 'admin', 3543, 14238, 'system and service manager', 'libacl1 libaudit1 libc6 libcap2 libcryptsetup12 libsystemd0 mount', 'i', 'systemctl journalctl systemd-analyze hostnamectl timedatectl loginctl'],
  ['tar', '1.35+dfsg-3build1', 'utils', 618, 2954, 'GNU version of the tar archiving utility', 'libacl1 libc6 libselinux1', 'i', 'tar'],
  ['tmux', '3.4-1ubuntu0.1', 'utils', 494, 1215, 'terminal multiplexer', 'libc6 libevent-core-2.1-7t64 libtinfo6 libutempter0', '', 'tmux'],
  ['tree', '2.1.1-2ubuntu3', 'utils', 51, 133, 'displays an indented directory tree, in color', 'libc6', '', 'tree'],
  ['ubuntu-desktop', '1.539.2', 'metapackages', 4, 46, 'Ubuntu desktop system', 'gnome-shell gnome-terminal nautilus firefox ubuntu-session', 'i', ''],
  ['ubuntu-minimal', '1.539.2', 'metapackages', 3, 40, 'Minimal core of Ubuntu', 'apt systemd sudo netplan.io', 'i', ''],
  ['ubuntu-standard', '1.539.2', 'metapackages', 3, 41, 'The Ubuntu standard system', 'ubuntu-minimal bash-completion less openssh-client rsync', 'i', ''],
  ['unzip', '6.0-28ubuntu4.1', 'utils', 174, 384, 'De-archiver for .zip files', 'libbz2-1.0 libc6', 'i', 'unzip funzip unzipsfx zipinfo'],
  ['util-linux', '2.39.3-9ubuntu6.1', 'utils', 1128, 3405, 'miscellaneous system utilities', 'libblkid1 libc6 libcap-ng0 libmount1 libselinux1 libsmartcols1 libudev1 libuuid1', 'i', 'dmesg lsblk lscpu more mount fdisk hexdump cal'],
  ['vim', '2:9.1.0016-1ubuntu7.5', 'editors', 1731, 3921, 'Vi IMproved - enhanced vi editor', 'vim-common vim-runtime libc6 libgpm2 libpython3.12 libselinux1 libtinfo6', '', 'vim vimdiff vimtutor rvim'],
  ['vim-tiny', '2:9.1.0016-1ubuntu7.5', 'editors', 733, 1826, 'Vi IMproved - enhanced vi editor - compact version', 'vim-common libc6 libselinux1 libtinfo6', 'i', 'vi vim.tiny'],
  ['wget', '1.21.4-1ubuntu4.1', 'web', 356, 1027, 'retrieves files from the web', 'libc6 libidn2-0 libpcre2-8-0 libpsl5t64 libssl3t64 zlib1g', 'i', 'wget'],
  ['xz-utils', '5.6.1+really5.4.5-1build0.1', 'utils', 274, 660, 'XZ-format compression utilities', 'libc6 liblzma5', 'i', 'xz unxz xzcat lzma unlzma'],
  ['zip', '3.0-13ubuntu0.1', 'utils', 176, 588, 'Archiver for .zip files', 'libbz2-1.0 libc6', 'i', 'zip zipcloak zipnote zipsplit'],
  ['zlib1g', '1:1.3.dfsg-3.1ubuntu2.1', 'libs', 61, 165, 'compression library - runtime', 'libc6', 'i', ''],
  ['zsh', '5.9-6ubuntu2', 'shells', 892, 2856, 'shell with lots of features', 'zsh-common libc6 libcap2 libtinfo6', '', 'zsh zsh5'],
  ['figlet', '2.2.5-3build1', 'text', 190, 741, 'Make large character ASCII banners out of ordinary text', 'libc6', '', 'figlet chkfont figlist showfigfonts'],
  ['fortunes-min', '1:1.99.1-7.1', 'games', 45, 156, 'Data files containing fortune cookies', '', '', ''],
  ['sl', '5.02-1build1', 'games', 26, 82, 'Correct you if you type `sl’ by mistake', 'libc6 libncurses6', '', 'sl'],
  ['lolcat', '100.0.1-3', 'games', 12, 51, 'rainbow coloring effect for text console display', 'ruby', '', 'lolcat'],
  ['toilet', '0.3-1.4build1', 'text', 26, 92, 'display large colourful characters in text mode', 'libcaca0 libc6', '', 'toilet toilet-figlet'],
  ['docker.io', '24.0.7-0ubuntu4.1', 'admin', 27394, 116400, 'Linux container runtime', 'containerd iptables libc6 runc', '', 'docker dockerd'],
  ['gnupg2', '2.4.4-2ubuntu17.2', 'utils', 5, 24, 'GNU privacy guard - a free PGP replacement (dummy transitional package)', 'gnupg', '', ''],
  ['htop-dbg', '3.3.0-4build1', 'debug', 244, 620, 'debug symbols for htop', 'htop', '', ''],
  ['iotop', '0.6-42-ga14256a-0ubuntu1', 'admin', 20, 82, 'simple top-like I/O monitor', 'python3', '', 'iotop'],
  ['ncdu', '1.19-1', 'utils', 51, 122, 'ncurses disk usage viewer', 'libc6 libncursesw6', '', 'ncdu'],
  ['nmap', '7.94+git20230807.3be01efb1+dfsg-3build2', 'net', 1972, 6404, 'The Network Mapper', 'libc6 liblua5.4-0 libpcap0.8t64 libssl3t64 zlib1g', '', 'nmap ncat nping'],
  ['traceroute', '1:2.1.5-1', 'net', 46, 152, 'Traces the route taken by packets over an IPv4/IPv6 network', 'libc6', 'i', 'traceroute traceroute6 tcptraceroute'],
  ['dnsutils', '1:9.18.28-0ubuntu0.24.04.1', 'net', 4, 34, 'Transitional package for bind9-dnsutils', 'bind9-dnsutils', 'i', ''],
  ['bind9-dnsutils', '1:9.18.28-0ubuntu0.24.04.1', 'net', 156, 462, 'Clients provided with BIND 9', 'bind9-host libc6 libidn2-0', 'i', 'dig nslookup nsupdate delv'],
  ['bind9-host', '1:9.18.28-0ubuntu0.24.04.1', 'net', 51, 124, 'DNS lookup utility (deprecated)', 'libc6 libidn2-0', 'ia', 'host'],
  ['whois', '5.5.22', 'net', 68, 200, 'intelligent WHOIS client', 'libc6 libidn2-0', '', 'whois'],
  ['telnet', '0.17+2.5-3ubuntu4', 'net', 4, 32, 'transitional dummy package for inetutils-telnet', 'inetutils-telnet', '', ''],
  ['ffmpeg', '7:6.1.1-3ubuntu5', 'video', 1912, 3844, 'Tools for transcoding, streaming and playing of multimedia files', 'libavcodec60 libavformat60 libc6', '', 'ffmpeg ffplay ffprobe'],
  ['vlc', '3.0.20-3build6', 'video', 2160, 6820, 'multimedia player and streamer', 'libvlc5 libqt5core5t64 vlc-bin', '', 'vlc cvlc nvlc'],
  ['libreoffice', '4:24.2.7-0ubuntu0.24.04.4', 'editors', 24, 122, 'office productivity suite (metapackage)', 'libreoffice-writer libreoffice-calc libreoffice-impress', 'i', 'libreoffice soffice'],
  ['thunderbird', '1:115.15.0+build1-0ubuntu0.24.04.1', 'mail', 62400, 224800, 'Email, RSS and newsgroup client with integrated spam filter', 'libc6 libgtk-3-0t64 libstdc++6', 'i', 'thunderbird'],
  ['nautilus', '1:46.2-0ubuntu1', 'gnome', 1204, 5510, 'file manager and graphical shell for GNOME', 'libgtk-4-1 libadwaita-1-0 gsettings-desktop-schemas', 'i', 'nautilus'],
  ['gnome-control-center', '1:46.0.1-1ubuntu5.1', 'gnome', 5316, 17204, 'utilities to configure the GNOME desktop', 'gnome-settings-daemon libgtk-4-1 libadwaita-1-0', 'i', 'gnome-control-center'],
  ['gnome-system-monitor', '46.0-1build1', 'gnome', 462, 1988, 'Process viewer and system resource monitor for GNOME', 'libgtk-4-1 libgtop-2.0-11 libadwaita-1-0', 'i', 'gnome-system-monitor'],
  ['ubuntu-drivers-common', '1:0.9.7.6', 'admin', 74, 434, 'Detect and install additional Ubuntu driver packages', 'python3 python3-apt', 'i', 'ubuntu-drivers'],
  ['update-manager', '1:24.04.9', 'gnome', 92, 468, 'GNOME application that manages apt updates', 'python3 update-manager-core', 'i', 'update-manager'],
  ['update-notifier', '3.192.68', 'gnome', 152, 604, 'Daemon which notifies about package updates', 'update-notifier-common libgtk-3-0t64', 'i', 'update-notifier'],
  ['landscape-common', '23.02-0ubuntu5', 'admin', 84, 452, 'Landscape administration system client - Common files', 'python3 lsb-release', 'i', 'landscape-sysinfo'],
  ['plymouth', '24.004.60-1ubuntu8', 'misc', 195, 588, 'boot animation, logger and I/O multiplexer', 'libplymouth5 libc6 systemd', 'i', 'plymouth'],
  ['ubuntu-advantage-tools', '32.3.1~24.04', 'admin', 264, 1420, 'Management tools for Ubuntu Pro', 'python3 python3-apt', 'i', 'pro ua'],
  ['pciutils', '1:3.10.0-2build1', 'admin', 269, 1470, 'PCI utilities', 'libc6 libkmod2 libpci3', 'i', 'lspci setpci'],
  ['usbutils', '1:017-3build1', 'utils', 89, 314, 'Linux USB utilities', 'libc6 libusb-1.0-0', 'i', 'lsusb usb-devices'],
  ['strace', '6.8-0ubuntu2', 'devel', 1362, 3708, 'System call tracer', 'libc6 libunwind8', '', 'strace strace-log-merge'],
  ['ltrace', '0.7.3-6.3ubuntu2', 'devel', 137, 400, 'Tracks runtime library calls in dynamically linked programs', 'libc6 libelf1t64', '', 'ltrace'],
  ['valgrind', '1:3.22.0-0ubuntu3', 'devel', 15920, 78200, 'instrumentation framework for building dynamic analysis tools', 'libc6 libc6-dbg', '', 'valgrind callgrind_annotate ms_print'],
  ['cmake', '3.28.3-1build7', 'devel', 8214, 32660, 'cross-platform, open-source make system', 'libc6 libcurl4t64 libexpat1 libuv1t64 zlib1g', '', 'cmake ctest cpack'],
  ['golang-go', '2:1.22~2build1', 'golang', 12, 62, 'Go programming language compiler - metapackage', 'golang-1.22-go', '', 'go gofmt'],
  ['default-jdk', '2:1.21-75+exp1', 'java', 3, 22, 'Standard Java or Java compatible Development Kit', 'openjdk-21-jdk default-jre', '', 'javac java'],
  ['sqlite3', '3.45.1-1ubuntu2.3', 'database', 143, 486, 'Command line interface for SQLite 3', 'libc6 libreadline8t64 libsqlite3-0', '', 'sqlite3'],
  ['postgresql', '16+257build1.1', 'database', 4, 60, 'object-relational SQL database (supported version)', 'postgresql-16', '', 'psql'],
  ['mysql-server', '8.0.39-0ubuntu0.24.04.2', 'database', 6, 44, 'MySQL database server (metapackage depending on the latest version)', 'mysql-server-8.0', '', 'mysql mysqld'],
  ['redis-server', '5:7.0.15-1ubuntu0.24.04.1', 'database', 1214, 4200, 'Persistent key-value database with network interface', 'redis-tools libc6 adduser', '', 'redis-server redis-cli'],
  ['ansible', '9.2.0+dfsg-0ubuntu5', 'admin', 21400, 216000, 'Configuration management, deployment, and task execution system', 'ansible-core python3', '', 'ansible ansible-playbook ansible-galaxy'],
  ['terraform', '1.7.4-1', 'devel', 21440, 78200, 'infrastructure as code software tool', 'libc6', '', 'terraform'],
  ['kubectl', '1.29.4-1', 'admin', 11200, 48600, 'Kubernetes command line tool', 'libc6', '', 'kubectl'],
  ['neovim', '0.9.5-6ubuntu2', 'editors', 2216, 5420, 'heavily refactored vim fork', 'libc6 libluajit-5.1-2 libtree-sitter0 neovim-runtime', '', 'nvim'],
  ['emacs', '1:29.3+1-1ubuntu2', 'editors', 6, 42, 'GNU Emacs editor (metapackage)', 'emacs-gtk', '', 'emacs'],
  ['screen', '4.9.1-1build1', 'misc', 668, 1140, 'terminal multiplexer with VT100/ANSI terminal emulation', 'libc6 libpam0g libtinfo6', '', 'screen'],
  ['zip-doc', '3.0-13ubuntu0.1', 'doc', 122, 340, 'Documentation for Info-ZIP’s zip', '', '', ''],
  ['fonts-firacode', '6.2-1', 'fonts', 1640, 3200, 'Monospaced font with programming ligatures', '', '', ''],
  ['hollywood', '1.21', 'games', 20, 68, 'fill your console with Hollywood melodrama technobabble', 'byobu tmux', '', 'hollywood'],
];

/** Packages whose candidate version is newer than what is installed. */
const UPGRADES = {
  'apt': '2.7.14build3',
  'bash': '5.2.21-2ubuntu4.1',
  'curl': '8.5.0-2ubuntu10.7',
  'libc6': '2.39-0ubuntu8.4',
  'libc-bin': '2.39-0ubuntu8.4',
  'libssl3t64': '3.0.13-0ubuntu3.5',
  'openssl': '3.0.13-0ubuntu3.5',
  'python3.12': '3.12.3-1ubuntu0.4',
  'libpython3.12': '3.12.3-1ubuntu0.4',
  'snapd': '2.63+24.04ubuntu0.2',
  'systemd': '255.4-1ubuntu8.5',
  'libsystemd0': '255.4-1ubuntu8.5',
  'vim-tiny': '2:9.1.0016-1ubuntu7.6',
  'wget': '1.21.4-1ubuntu4.2',
};

/** Snap packages present on a stock desktop image. */
const SNAP_SEED = [
  { name: 'bare', version: '1.0', rev: '5', tracking: 'latest/stable', publisher: 'canonical**', notes: 'base', size: 4096 },
  { name: 'core22', version: '20240823', rev: '1612', tracking: 'latest/stable', publisher: 'canonical**', notes: 'base', size: 77594624 },
  { name: 'firefox', version: '129.0.2-1', rev: '4848', tracking: 'latest/stable/…', publisher: 'mozilla**', notes: '-', size: 279969792 },
  { name: 'gnome-42-2204', version: '0+git.510a601', rev: '176', tracking: 'latest/stable/…', publisher: 'canonical**', notes: '-', size: 351272960 },
  { name: 'gtk-common-themes', version: '0.1-81-g442e511', rev: '1535', tracking: 'latest/stable/…', publisher: 'canonical**', notes: '-', size: 96468992 },
  { name: 'snap-store', version: '41.3-77-g7dc86c8', rev: '1113', tracking: 'latest/stable/…', publisher: 'canonical**', notes: '-', size: 12902400 },
  { name: 'snapd', version: '2.63', rev: '21759', tracking: 'latest/stable', publisher: 'canonical**', notes: 'snapd', size: 42258432 },
  { name: 'snapd-desktop-integration', version: '0.9', rev: '178', tracking: 'latest/stable/…', publisher: 'canonical**', notes: '-', size: 528384 },
  { name: 'thunderbird', version: '115.15.0-1', rev: '511', tracking: 'latest/stable/…', publisher: 'canonical**', notes: '-', size: 289406976 },
];

/** Snaps discoverable through `snap find`, keyed by name. */
const SNAP_STORE = [
  { name: 'code', version: '1.92.2', publisher: 'Microsoft**', notes: 'classic', summary: 'Code editing. Redefined.', size: 108000000 },
  { name: 'spotify', version: '1.2.44.371', publisher: 'spotify**', notes: '-', summary: 'Music for everyone', size: 178000000 },
  { name: 'discord', version: '0.0.66', publisher: 'snapcrafters*', notes: '-', summary: 'All-in-one voice and text chat for gamers', size: 92000000 },
  { name: 'slack', version: '4.39.90', publisher: 'slack**', notes: '-', summary: 'Team communication for the 21st century', size: 118000000 },
  { name: 'postman', version: '11.6.0', publisher: 'Postman, Inc.**', notes: '-', summary: 'API Development Environment', size: 205000000 },
  { name: 'docker', version: '24.0.5', publisher: 'canonical**', notes: '-', summary: 'Docker container runtime', size: 168000000 },
  { name: 'go', version: '1.23.0', publisher: 'canonical**', notes: 'classic', summary: 'Go programming language compiler', size: 76000000 },
  { name: 'node', version: '22.7.0', publisher: 'Snapcrafters*', notes: 'classic', summary: 'Node.js is an open-source JavaScript runtime', size: 51000000 },
  { name: 'kubectl', version: '1.31.0', publisher: 'canonical**', notes: 'classic', summary: 'Kubernetes command line tool', size: 48000000 },
  { name: 'chromium', version: '128.0.6613.84', publisher: 'canonical**', notes: '-', summary: 'Chromium web browser, open-source version of Chrome', size: 172000000 },
  { name: 'obs-studio', version: '30.2.2', publisher: 'snapcrafters*', notes: '-', summary: 'Live video production made easy', size: 231000000 },
  { name: 'blender', version: '4.2.1', publisher: 'blenderfoundation**', notes: 'classic', summary: 'Open source 3D creation suite', size: 312000000 },
  { name: 'htop', version: '3.3.0', publisher: 'maxiberta*', notes: '-', summary: 'Interactive process viewer', size: 4200000 },
  { name: 'hello-world', version: '6.4', publisher: 'canonical**', notes: '-', summary: 'The ‘hello-world’ of snaps', size: 20480 },
];

/** @type {Map<string, object>} */
const packages = new Map();

for (const row of CATALOGUE) {
  const [name, version, section, download, installedKb, description, depends, flags, bins] = row;
  packages.set(name, {
    name,
    version,
    candidate: UPGRADES[name] || version,
    section,
    arch: 'amd64',
    priority: flags.includes('i') ? 'important' : 'optional',
    download,
    installedKb,
    description,
    depends: depends ? depends.split(' ').filter(Boolean) : [],
    binaries: bins ? bins.split(' ').filter(Boolean) : [],
    installed: flags.includes('i'),
    auto: flags.includes('a'),
    origin: 'Ubuntu:24.04/noble',
  });
}

/** Names installed by the seed image — the baseline `apt autoremove` respects. */
const SEED_INSTALLED = new Set(
  Array.from(packages.values()).filter((p) => p.installed).map((p) => p.name),
);

let state = null;
/** @type {object[]} */
let snaps = [];

function defaultState() {
  return {
    installed: Array.from(SEED_INSTALLED),
    auto: Array.from(packages.values()).filter((p) => p.auto).map((p) => p.name),
    versions: {},
    lastUpdate: 0,
  };
}

function loadState() {
  if (state) return state;
  const saved = store.get(STORE_KEY, null);
  if (saved && Array.isArray(saved.installed)) {
    state = {
      installed: saved.installed.filter((n) => packages.has(n)),
      auto: Array.isArray(saved.auto) ? saved.auto.filter((n) => packages.has(n)) : [],
      versions: saved.versions && typeof saved.versions === 'object' ? { ...saved.versions } : {},
      lastUpdate: Number(saved.lastUpdate) || 0,
    };
  } else {
    state = defaultState();
  }
  applyState();
  return state;
}

function applyState() {
  const installed = new Set(state.installed);
  const auto = new Set(state.auto);
  for (const pkg of packages.values()) {
    pkg.installed = installed.has(pkg.name);
    pkg.auto = auto.has(pkg.name);
    const pinned = state.versions[pkg.name];
    if (typeof pinned === 'string' && pinned !== '') pkg.version = pinned;
  }
}

function saveState() {
  if (!state) return;
  store.set(STORE_KEY, state);
}

function loadSnaps() {
  if (snaps.length) return snaps;
  const saved = store.get(SNAP_KEY, null);
  if (Array.isArray(saved) && saved.length) snaps = saved.map((s) => ({ ...s }));
  else snaps = SNAP_SEED.map((s) => ({ ...s }));
  return snaps;
}

function saveSnaps() {
  store.set(SNAP_KEY, snaps);
}

/** Total download size, in KB, of a package list. */
function sumDownload(names) {
  let kb = 0;
  for (const n of names) {
    const p = packages.get(n);
    if (p) kb += p.download;
  }
  return kb;
}

/** Total installed footprint, in KB, of a package list. */
function sumInstalled(names) {
  let kb = 0;
  for (const n of names) {
    const p = packages.get(n);
    if (p) kb += p.installedKb;
  }
  return kb;
}

export const pkgdb = {
  /** @returns {object[]} every known package, alphabetically */
  all() {
    loadState();
    return Array.from(packages.values()).sort((a, b) => a.name.localeCompare(b.name));
  },

  /**
   * @param {string} name
   * @returns {object|null}
   */
  get(name) {
    loadState();
    return packages.get(String(name)) || null;
  },

  /** @param {string} name @returns {boolean} */
  has(name) {
    return packages.has(String(name));
  },

  /** @param {string} name @returns {boolean} */
  isInstalled(name) {
    loadState();
    const p = packages.get(String(name));
    return Boolean(p && p.installed);
  },

  /** @returns {object[]} installed packages, alphabetically */
  installed() {
    return pkgdb.all().filter((p) => p.installed);
  },

  /** @returns {object[]} installed packages with a newer candidate */
  upgradable() {
    return pkgdb.installed().filter((p) => p.candidate !== p.version);
  },

  /**
   * Resolve the not-yet-installed dependency closure of a package.
   * @param {string} name
   * @returns {string[]} extra packages that must be pulled in
   */
  resolveDeps(name) {
    loadState();
    const out = [];
    const seen = new Set([String(name)]);
    const queue = [String(name)];
    while (queue.length) {
      const current = packages.get(queue.shift());
      if (!current) continue;
      for (const dep of current.depends) {
        if (seen.has(dep)) continue;
        seen.add(dep);
        const p = packages.get(dep);
        if (!p || p.installed) continue;
        out.push(dep);
        queue.push(dep);
      }
    }
    return out;
  },

  /**
   * Packages that would be freed by `apt autoremove`: automatically installed
   * and no longer required by anything the user asked for.
   * @returns {string[]}
   */
  autoremovable() {
    loadState();
    const needed = new Set();
    for (const pkg of packages.values()) {
      if (!pkg.installed || pkg.auto) continue;
      for (const dep of pkg.depends) needed.add(dep);
    }
    return Array.from(packages.values())
      .filter((p) => p.installed && p.auto && !needed.has(p.name) && !SEED_INSTALLED.has(p.name))
      .map((p) => p.name)
      .sort();
  },

  /**
   * Mark a package installed.
   * @param {string} name
   * @param {{auto?:boolean, version?:string}} [opts]
   */
  markInstalled(name, opts = {}) {
    loadState();
    const key = String(name);
    if (!packages.has(key)) return false;
    if (!state.installed.includes(key)) state.installed.push(key);
    const autoIdx = state.auto.indexOf(key);
    if (opts.auto && autoIdx < 0) state.auto.push(key);
    if (!opts.auto && autoIdx >= 0) state.auto.splice(autoIdx, 1);
    if (opts.version) state.versions[key] = opts.version;
    applyState();
    saveState();
    return true;
  },

  /**
   * Mark a package removed.
   * @param {string} name
   * @returns {boolean}
   */
  markRemoved(name) {
    loadState();
    const key = String(name);
    const idx = state.installed.indexOf(key);
    if (idx < 0) return false;
    state.installed.splice(idx, 1);
    const autoIdx = state.auto.indexOf(key);
    if (autoIdx >= 0) state.auto.splice(autoIdx, 1);
    applyState();
    saveState();
    return true;
  },

  /**
   * Move a package to its candidate version.
   * @param {string} name
   * @returns {boolean}
   */
  markUpgraded(name) {
    loadState();
    const pkg = packages.get(String(name));
    if (!pkg || !pkg.installed || pkg.candidate === pkg.version) return false;
    state.versions[pkg.name] = pkg.candidate;
    applyState();
    saveState();
    return true;
  },

  /** Epoch ms of the last successful `apt update`, 0 when never run. */
  lastUpdate() {
    loadState();
    return state.lastUpdate;
  },

  /** Record that `apt update` just ran. */
  touchUpdate() {
    loadState();
    state.lastUpdate = Date.now();
    saveState();
  },

  /** Restore the pristine seed database. */
  reset() {
    state = defaultState();
    applyState();
    saveState();
    snaps = SNAP_SEED.map((s) => ({ ...s }));
    saveSnaps();
  },

  /**
   * Case-insensitive search over name and description.
   * @param {string} query
   * @returns {object[]}
   */
  search(query) {
    const q = String(query).toLowerCase();
    if (q === '') return [];
    return pkgdb.all().filter(
      (p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q),
    );
  },

  sumDownload,
  sumInstalled,

  /** @returns {object[]} installed snaps */
  snapList() {
    return loadSnaps().map((s) => ({ ...s }));
  },

  /**
   * @param {string} name
   * @returns {object|null} the store entry, or null when unknown
   */
  snapLookup(name) {
    const key = String(name).toLowerCase();
    return SNAP_STORE.find((s) => s.name === key) || null;
  },

  /**
   * @param {string} query
   * @returns {object[]}
   */
  snapSearch(query) {
    const q = String(query).toLowerCase();
    if (q === '') return SNAP_STORE.slice();
    return SNAP_STORE.filter(
      (s) => s.name.includes(q) || s.summary.toLowerCase().includes(q),
    );
  },

  /**
   * @param {string} name
   * @returns {object|null} the newly installed snap record
   */
  snapInstall(name) {
    const entry = pkgdb.snapLookup(name);
    if (!entry) return null;
    const list = loadSnaps();
    if (list.some((s) => s.name === entry.name)) return null;
    const record = {
      name: entry.name,
      version: entry.version,
      rev: String(100 + Math.floor(Math.random() * 900)),
      tracking: 'latest/stable',
      publisher: entry.publisher,
      notes: entry.notes,
      size: entry.size,
    };
    list.push(record);
    saveSnaps();
    return { ...record };
  },

  /**
   * @param {string} name
   * @returns {boolean}
   */
  snapRemove(name) {
    const list = loadSnaps();
    const idx = list.findIndex((s) => s.name === String(name));
    if (idx < 0) return false;
    list.splice(idx, 1);
    saveSnaps();
    return true;
  },
};
