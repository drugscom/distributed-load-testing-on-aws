FROM blazemeter/taurus:1.16.26
# taurus includes python and pip
RUN /usr/bin/python3 -m pip install --upgrade pip
RUN pip install --no-cache-dir awscli
RUN apt-get -y install xmlstarlet bc procps
# Taurus working directory  = /bzt-configs
ADD ./load-test.sh /bzt-configs/
ADD ./*.jar /bzt-configs/
ADD ./*.py /bzt-configs/
RUN chmod 755 /bzt-configs/load-test.sh
RUN chmod 755 /bzt-configs/ecslistener.py
RUN chmod 755 /bzt-configs/ecscontroller.py
ENTRYPOINT ["./load-test.sh"]
