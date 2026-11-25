#!/usr/bin/env python3
"""Cliente RDP falso para o X11 (Linux), como o xfreerdp encaixado: cria a própria janela dentro
de /parent-window, lê a senha da entrada padrão (/from-stdin:force) e registra no FAKE_RDP_LOG os
argumentos, a senha, a janela e os cliques e teclas que chegam a ela."""
import ctypes
import os
import sys

args = sys.argv[1:]
if '--version' in args:
    print('This is FreeRDP version 3.99.0 (falso)')
    sys.exit(0)

opt = lambda name: next((a.split(':', 1)[1] for a in args if a.startswith(f'/{name}:')), None)
parent = int(opt('parent-window'))
w, h = map(int, opt('size').split('x'))
password = sys.stdin.readline().rstrip('\n')

x = ctypes.CDLL('libX11.so.6')
vp, ul = ctypes.c_void_p, ctypes.c_ulong
x.XOpenDisplay.restype = vp
x.XOpenDisplay.argtypes = [ctypes.c_char_p]
x.XCreateSimpleWindow.restype = ul
x.XCreateSimpleWindow.argtypes = [vp, ul, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint, ctypes.c_uint, ul, ul]
x.XSelectInput.argtypes = [vp, ul, ctypes.c_long]
x.XMapWindow.argtypes = [vp, ul]
x.XFlush.argtypes = [vp]
x.XNextEvent.argtypes = [vp, vp]
x.XLookupKeysym.restype = ul
x.XLookupKeysym.argtypes = [vp, ctypes.c_int]

d = x.XOpenDisplay(None)
win = x.XCreateSimpleWindow(d, parent, 0, 0, w, h, 0, 0, 0xFF0000)
KEY_PRESS, BUTTON_PRESS = 1 << 0, 1 << 2
x.XSelectInput(d, win, KEY_PRESS | BUTTON_PRESS)
x.XMapWindow(d, win)
x.XFlush(d)

log = open(os.environ['FAKE_RDP_LOG'], 'a', encoding='utf-8')
def write(line):
    log.write(line + '\n')
    log.flush()

write('args ' + ' '.join(args))
write('senha ' + password)
write(f'xid {win}')
event = ctypes.create_string_buffer(192)
while True:
    x.XNextEvent(d, event)
    kind = ctypes.c_int.from_buffer(event).value
    if kind == 2:  # KeyPress
        write(f'tecla {x.XLookupKeysym(event, 0):#x}')
    elif kind == 4:  # ButtonPress
        write('clique')
