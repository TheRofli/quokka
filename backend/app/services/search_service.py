import httpx
import asyncio
from typing import List, Optional
from dataclasses import dataclass
from urllib.parse import quote

@dataclass
class SearchResult:
    title: str
    url: str
    content: str
    score: float

class WebSearchService:
    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key
        self.client = httpx.AsyncClient(timeout=10.0)
    
    async def search_duckduckgo(self, query: str, max_results: int = 3) -> List[SearchResult]:
        """Perform web search using DuckDuckGo Instant Answer API"""
        try:
            encoded_query = quote(query)
            url = f"https://api.duckduckgo.com/?q={encoded_query}&format=json&no_html=1&skip_disambig=1"
            
            response = await self.client.get(url)
            response.raise_for_status()
            
            data = response.json()
            
            results = []
            if data.get('RelatedTopics'):
                for topic in data['RelatedTopics'][:max_results]:
                    if 'Text' in topic and 'FirstURL' in topic:
                        results.append(SearchResult(
                            title=topic.get('Text', ''),
                            url=topic['FirstURL'],
                            content=topic.get('Text', ''),
                            score=1.0  # DuckDuckGo doesn't provide scores, using default
                        ))
            
            # If no topics found, try Abstract field
            if not results and data.get('Abstract'):
                results.append(SearchResult(
                    title=data.get('Heading', 'Search Result'),
                    url=data.get('AbstractURL', ''),
                    content=data.get('Abstract', ''),
                    score=1.0
                ))
            
            return results
            
        except Exception as e:
            print(f"DuckDuckGo search failed: {e}")
            return []
    
    async def search_tavily(self, query: str, max_results: int = 3) -> List[SearchResult]:
        """Perform web search using Tavily API (requires API key)"""
        if not self.api_key:
            return []
        
        try:
            url = "https://api.tavily.com/search"
            payload = {
                "api_key": self.api_key,
                "query": query,
                "max_results": max_results,
                "search_depth": "basic",
                "include_answer": True,
                "include_images": False,
                "include_raw_content": False,
                "result_format": "json"
            }
            
            response = await self.client.post(url, json=payload)
            response.raise_for_status()
            
            data = response.json()
            results = []
            
            for result in data.get('results', [])[:max_results]:
                results.append(SearchResult(
                    title=result.get('title', ''),
                    url=result.get('url', ''),
                    content=result.get('content', ''),
                    score=float(result.get('score', 0.0))
                ))
            
            return results
            
        except Exception as e:
            print(f"Tavily search failed: {e}")
            return []
    
    async def search(self, query: str, max_results: int = 3, provider: str = "duckduckgo") -> List[SearchResult]:
        """Main search method that can use different providers"""
        if provider == "tavily":
            return await self.search_tavily(query, max_results)
        else:
            return await self.search_duckduckgo(query, max_results)
    
    async def search_and_augment(self, query: str, provider: str = "duckduckgo") -> str:
        """Search and format results for context augmentation"""
        results = await self.search(query, max_results=3, provider=provider)
        
        if not results:
            return f"\n\n[Поиск в интернете не дал результатов для запроса: '{query}']"
        
        augmented_context = "\n\n[НАЙДЕНАЯ ИНФОРМАЦИЯ ИЗ ИНТЕРНЕТА]:\n"
        for i, result in enumerate(results, 1):
            augmented_context += f"\nРезультат {i}:\n"
            augmented_context += f"Заголовок: {result.title}\n"
            augmented_context += f"URL: {result.url}\n"
            augmented_context += f"Содержание: {result.content}\n"
        
        augmented_context += f"\n[КОНЕЦ НАЙДЕННОЙ ИНФОРМАЦИИ]\n\n"
        augmented_context += f"Пожалуйста, используйте вышеупомянутую информацию для ответа на вопрос: {query}"
        
        return augmented_context

# Global instance
search_service = WebSearchService()
