# Inert native CodeQL qualification data; never imported or called.
import logging


def native_probe_high(credentials):
    logging.error(credentials.password)
