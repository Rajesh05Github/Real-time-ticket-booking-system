# syntax=docker/dockerfile:1
#
# Public gateway for the Azure Container Apps deployment -- see
# default.conf.template and docs/azure-deployment.md.
#
# Build context: this directory (infra/azure/gateway).

FROM nginx:1.27-alpine

# Populates ${NGINX_LOCAL_RESOLVERS} from /etc/resolv.conf at start
# (the official image's 15-local-resolvers.envsh), so the template can
# use Container Apps' own DNS server without hardcoding its address.
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1

# Rendered into /etc/nginx/conf.d/default.conf at container start.
# API_UPSTREAM_HOST / WEB_UPSTREAM_HOST are supplied by the container app
# (infra/azure/terraform/container-apps.tf).
COPY default.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 8080

# Run as the image's unprivileged nginx user; listening on 8080 (not 80)
# needs no extra capabilities.
RUN chown -R nginx:nginx /var/cache/nginx /etc/nginx/conf.d && \
    touch /var/run/nginx.pid && chown nginx:nginx /var/run/nginx.pid
USER nginx
