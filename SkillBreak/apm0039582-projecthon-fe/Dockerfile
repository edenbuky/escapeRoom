FROM artifact.it.att.com/docker-public-group/nginx:stable-alpine

COPY --chown=nginx:nginx ./dist /usr/share/nginx/html/

RUN chown -R nginx:nginx \
    /var/cache/nginx \
    /var/log/nginx \
    /etc/nginx/conf.d \
&& chmod -R 755 /usr/share/nginx/html/ \
&& chmod -R 755 /etc/nginx/

WORKDIR /etc/nginx/

USER nginx

ENTRYPOINT ["nginx-debug", "-g", "daemon off;"]
