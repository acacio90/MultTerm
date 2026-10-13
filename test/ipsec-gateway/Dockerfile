# Gateway IPsec de teste (strongSwan) para o motor de VPN do MultTerm. Só para testes locais.
FROM ubuntu:24.04
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      strongswan-swanctl strongswan-charon libcharon-extra-plugins libcharon-extauth-plugins libstrongswan-extra-plugins iproute2 iputils-ping \
 && rm -rf /var/lib/apt/lists/*
COPY swanctl.conf /etc/swanctl/swanctl.conf
COPY strongswan.conf /etc/strongswan.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 500/udp 4500/udp
ENTRYPOINT ["/entrypoint.sh"]
