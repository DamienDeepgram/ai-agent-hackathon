import json
import requests
from crewai_tools import tool
from crewai_tools import BaseTool

url = 'http://localhost:8080/call'

class PhoneCallTool(BaseTool):
    name: str = "PhoneCallTool"
    description: str = "Makes a phonecall"

    def _run(self, payload: str) -> str:
      """Useful to call a phone number with a goal
      :param payload: str, a string representation of dictionary containing the following keys:

      goal: str, the goal to carry out on the call
      number: str, the number to call

      example payload:
      {
          "goal": "Find out opening hours for Memorial Day.",
          "number": "+14151234567"
      }
    """
      print(f"values: {payload} {type(payload)}")
      jsonObj = json.loads(payload)
      goal = jsonObj['goal']
      number = jsonObj['number']

      transcript = ''
      try:
        print("")
        print("[ACTION] PhoneCallTool:")
        print(f"  Calling {number}")
        print(f"  Goal {goal}")
        payload = {'number': number.strip(), 'goal': goal.strip()}

        response = requests.post(url, json=payload)

        if response.status_code == 200:
            jsonObj = response.json()
            transcript = jsonObj.get('transcript')
            print('PhoneCallTool:')
            print('  Call Transcript:', transcript)
        else:
            print('Request failed with status code:', response.status_code)
            print('Response:', response.text)
      except Exception as err:
        print('Error parsing JSON:', err)
        return f"error: {err} \n\n STATUS: Fail"

      print("[RESULT] PhoneCallTool:")
      print("   Call Ended")
         
      return f"transcript: {transcript} \n\n STATUS: Success"
