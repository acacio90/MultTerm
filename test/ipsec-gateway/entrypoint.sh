#!/bin/sh
# Rede "protegida" atrás do gateway: 10.99.0.1 responde ping pelo túnel.
ip link add prot0 type dummy 2>/dev/null
ip addr add 10.99.0.1/24 dev prot0 2>/dev/null
ip link set prot0 up
/usr/lib/ipsec/charon &
for i in $(seq 1 50); do [ -S /var/run/charon.vici ] && break; sleep 0.2; done
swanctl --load-all
wait
