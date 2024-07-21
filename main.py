from dotenv import load_dotenv
import os
from langchain_groq import ChatGroq
from crewai import Agent, Task, Crew
from phonecall_tool import PhoneCallTool
import json
import requests
import argparse
# import agentops

load_dotenv()

# agentops.init(os.getenv('AGENTOPS_API_KEY'))

#
#   MultiOn
#
from multion.client import MultiOn
client = MultiOn(
    api_key=os.getenv('MULTION_API_KEY')
)

#
#   WordWare
#
# @agentops.record_function('findClosestStore')
def findClosestStore(store, location):
    prompt_id = os.getenv('WORDWARE_PROMPT_ID')
    api_key = os.getenv('WORDWARE_API_KEY')

    # Describe the prompt (shows just the inputs for now)
    r1 = requests.get(f'https://app.wordware.ai/api/prompt/{prompt_id}/describe',
                      headers={'Authorization': f'Bearer {api_key}'})
    # Execute the prompt
    r = requests.post(f'https://app.wordware.ai/api/prompt/{prompt_id}/run',
        json={'inputs': {'store': store, 'location': location}},
        headers={'Authorization': f'Bearer {api_key}'},
        stream=True
        )
    if r.status_code != 200:
        print('WordWare: Request failed with status code', r.status_code)
        print(f'WordWare Error: {json.dumps(r.json(), indent=4)}')
    else:
        for line in r.iter_lines():
            if line:
                content = json.loads(line.decode('utf-8'))
                result = content['value']
                if result['type'] == 'outputs':
                    return result['values']['address']['result']['address']
    return False

#
#   MultiOn
#
def findPhoneNumber(store, address):
    success = False
    while not success:
        try:
            response = client.browse(
                cmd=f'Find the phone number for {store} at {address}. Return ONLY the phone number do not return any other text.',
                url='https://google.com'
            )
            success = True
        except Exception as err:
            print(f'MultiOn Error: {err}')
            print('MultiOn: Retrying...')
    return response.message

#
#   CrewAI + Groq
#
def callStore(store, phoneNumber, goal):
    phonecall_tool_instance = PhoneCallTool()
    payload = phoneNumber+'|'+goal
    caller = Agent(
        role='Caller',
        goal=goal,
        backstory=(f'You are calling {store} to {goal}. Send the following string to the PhoneCallTool "{payload}"'),
        verbose=True,
        allow_delegation=False,
        memory=True,
        max_iter=2,
        tools=[phonecall_tool_instance],
        function_calling_llm=ChatGroq(model_name='mixtral-8x7b-32768'),
    )
    task = Task(
        description=goal,
        expected_output='The result of the goal: {goal}',
        agent=caller
    )
    crew = Crew(
        agents=[caller],
        tasks=[task]
    )
    result = crew.kickoff({"goal": goal})
    return result

def main():
    parser = argparse.ArgumentParser(description="Find store opening time")
    parser.add_argument("--store", type=str, required=True, help="Name of Store")
    parser.add_argument("--location", type=str, required=True, help="Location")
    parser.add_argument("--goal", type=str, required=True, help="Goal")

    args = parser.parse_args()

    print(f"Store: {args.store}")
    print(f"Location: {args.location}")
    print(f"Goal: {args.goal}")
    store = args.store
    location = args.location
    goal = args.goal
    
    # Use the Find Store WordWare Prompt to find the closest store
    print(f'[ACTION] WordWare:')
    print(f'  Find closest {store} in {location}')
    address = findClosestStore(store, location)
    print(f'[RESULT] WordWare:')
    print(f'  Address - {address}')
    
    # Use MultiOn to get the phone number from the store website
    print(f'[ACTION] MultiOn:')
    print(f'  Find Phone Number for {store} at {address}')
    phoneNumber = findPhoneNumber(store, address)
    print(f'[RESULT] MultiOn:')
    print(f'  Phone Number - {phoneNumber}')

    # Use CrewAI and Groq Mixtral-8x7b to use our custom PhoneCall Tool
    # PhoneCall Tool initiates a call
    print(f'[ACTION] CrewAI:')
    print(f'  Using PhoneCallTool to call: {phoneNumber}')
    openingHours = callStore(store, phoneNumber, goal)
    print(f'CrewAI:')
    print(f'  Result - {openingHours}')
    # agentops.end_session('Success')

if __name__ == '__main__':
    main()