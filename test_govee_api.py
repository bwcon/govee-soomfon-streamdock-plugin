import urllib.request
import json

def test_api(key):
    print("Testing v1...")
    try:
        req = urllib.request.Request("https://developer-api.govee.com/v1/devices", headers={"Govee-API-Key": key})
        res = urllib.request.urlopen(req, timeout=5)
        print("v1 response:", res.read().decode('utf-8'))
    except Exception as e:
        print("v1 error:", e)

    print("Testing v2...")
    try:
        req = urllib.request.Request("https://openapi.api.govee.com/router/api/v1/user/devices", headers={"Govee-API-Key": key})
        res = urllib.request.urlopen(req, timeout=5)
        print("v2 response:", res.read().decode('utf-8'))
    except Exception as e:
        print("v2 error:", e)

test_api("fake-key-1234")
